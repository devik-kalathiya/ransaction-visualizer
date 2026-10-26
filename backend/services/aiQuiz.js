"use strict";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const FALLBACK_MODEL =
    process.env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-120b";

const VALID_TOPICS = [
    "transactions",
    "acid",
    "schedules",
    "concurrency",
    "recovery",
    "locks"
];

const VALID_DIFFICULTIES = ["Easy", "Medium", "Hard"];

const BATCH_SIZE = 5;
const MAX_QUESTION_COUNT = 99;
const MAX_RETRY_ROUNDS = 2;
const BATCH_DELAY_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getRetryDelay(errorText) {
    try {
        const errorData = JSON.parse(errorText);
        const message = errorData.error?.message || "";

        const match = message.match(/try again in ([\d.]+)s/i);

        if (match) {
            return Math.ceil(Number(match[1]) * 1000) + 1500;
        }
    } catch {
        // Use the default delay if the error response is not JSON.
    }

    return 10000;
}

function validateQuestion(question, index, topic, difficulty) {
    if (!question || typeof question !== "object") {
        throw new Error(`Invalid question at position ${index + 1}.`);
    }

    const validTopic = VALID_TOPICS.includes(question.topic);

    const validDifficulty =
        VALID_DIFFICULTIES.includes(question.difficulty);

    const validOptions =
        Array.isArray(question.options) &&
        question.options.length === 4 &&
        question.options.every(
            (option) =>
                typeof option === "string" &&
                option.trim().length > 0
        ) &&
        new Set(
            question.options.map((option) => option.trim())
        ).size === 4;

    const validAnswer =
        Number.isInteger(question.answer) &&
        question.answer >= 0 &&
        question.answer <= 3;

    if (
        !validTopic ||
        !validDifficulty ||
        !validOptions ||
        !validAnswer ||
        typeof question.question !== "string" ||
        !question.question.trim() ||
        typeof question.explanation !== "string" ||
        !question.explanation.trim()
    ) {
        throw new Error(
            `The AI returned an invalid question at position ${index + 1}.`
        );
    }

    if (topic !== "all" && question.topic !== topic) {
        throw new Error(
            `Question ${index + 1} does not match the selected topic.`
        );
    }

    if (
        difficulty !== "all" &&
        question.difficulty !== difficulty
    ) {
        throw new Error(
            `Question ${index + 1} does not match the selected difficulty.`
        );
    }

    return {
        id: index + 1,
        topic: question.topic,
        difficulty: question.difficulty,
        source: "AI-generated",
        question: question.question.trim(),
        options: question.options.map((option) => option.trim()),
        answer: question.answer,
        explanation: question.explanation.trim()
    };
}

async function generateQuestionBatch({ topic, difficulty, count }) {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        throw new Error(
            "GROQ_API_KEY is not configured in backend/.env."
        );
    }

    if (topic !== "all" && !VALID_TOPICS.includes(topic)) {
        throw new Error(`Invalid quiz topic: ${topic}`);
    }

    if (
        difficulty !== "all" &&
        !VALID_DIFFICULTIES.includes(difficulty)
    ) {
        throw new Error(`Invalid difficulty: ${difficulty}`);
    }

    if (!Number.isInteger(count) || count < 1 || count > BATCH_SIZE) {
        throw new Error(
            `Question count per batch must be between 1 and ${BATCH_SIZE}.`
        );
    }

    const topicNames = {
        transactions: "Transaction lifecycle",
        acid: "ACID properties",
        schedules: "Schedules and serializability",
        concurrency: "Concurrency control",
        recovery: "Database recovery",
        locks: "Locks and deadlocks"
    };

    const selectedTopic =
        topic === "all"
            ? Object.values(topicNames).join(", ")
            : topicNames[topic];

    const selectedDifficulty =
        difficulty === "all"
            ? "Easy, Medium, and Hard"
            : difficulty;

    const prompt = `
You are an expert Database Management Systems examiner.

Generate exactly ${count} original DBMS multiple-choice questions.

Allowed topics:
${JSON.stringify(topicNames)}

Allowed difficulties:
Easy, Medium, Hard

Requested topic: ${topic}
Topic description: ${selectedTopic}

Requested difficulty: ${difficulty}
Difficulty description: ${selectedDifficulty}

STRICT RULES:
1. Return exactly ${count} questions.
2. Every question must have exactly four distinct string options.
3. Exactly one option must be correct.
4. The answer must be an integer from 0 to 3.
5. Include a technically accurate explanation.
6. Do not repeat questions within this batch.
7. Every question must use a valid topic key.
8. Every question must use a valid difficulty value.
9. If the requested topic is not "all", every question must use topic "${topic}".
10. If the requested difficulty is not "all", every question must use difficulty "${difficulty}".
11. If the topic is "all", distribute questions across the available DBMS topics where practical.
12. If the difficulty is "all", include a reasonable mixture of difficulties.
13. Return valid JSON only. Do not include Markdown or comments.
14. Return all questions without truncating the response.

Return this JSON structure:
{
  "questions": [
    {
      "topic": "acid",
      "difficulty": "Easy",
      "source": "AI-generated",
      "question": "Question text",
      "options": [
        "Option A",
        "Option B",
        "Option C",
        "Option D"
      ],
      "answer": 0,
      "explanation": "Explanation of the correct answer."
    }
  ]
}
`;

    const models = [...new Set([MODEL, FALLBACK_MODEL])];

    let lastError = null;
    let retryDelay = 10000;

    for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
        for (const currentModel of models) {
            console.log(
                `[aiQuiz] Using model: ${currentModel} (attempt ${round}/${MAX_RETRY_ROUNDS})`
            );

            let response;

            try {
                response = await fetch(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${apiKey}`
                        },
                        body: JSON.stringify({
                            model: currentModel,
                            temperature: 0.3,
                            max_tokens: Math.min(
                                5500,
                                count * 450 + 1000
                            ),
                            response_format: {
                                type: "json_object"
                            },
                            messages: [
                                {
                                    role: "system",
                                    content:
                                        "You are an expert DBMS examiner. Generate accurate multiple-choice questions and return a complete, valid JSON object only."
                                },
                                {
                                    role: "user",
                                    content: prompt
                                }
                            ]
                        }),
                        signal: AbortSignal.timeout(90000)
                    }
                );
            } catch (error) {
                console.error(
                    `[aiQuiz] Request failed for ${currentModel}:`,
                    error.message
                );

                throw new Error(
                    error.name === "TimeoutError"
                        ? "AI question generation timed out. Please retry."
                        : "Could not connect to Groq. Check your internet connection."
                );
            }

            if (response.ok) {
                let data;

                try {
                    data = await response.json();
                } catch {
                    throw new Error(
                        "Groq returned an invalid HTTP response."
                    );
                }

                const choice = data.choices?.[0];
                const output = choice?.message?.content?.trim();

                if (!output) {
                    throw new Error(
                        "The AI returned an empty response. Please retry."
                    );
                }

                if (choice.finish_reason === "length") {
                    throw new Error(
                        "The AI response was truncated. Try generating fewer questions."
                    );
                }

                let parsed;

                try {
                    parsed = JSON.parse(output);
                } catch {
                    console.error(
                        "[aiQuiz] Invalid JSON:",
                        output.slice(0, 1000)
                    );

                    throw new Error(
                        "The AI returned malformed JSON. Please retry."
                    );
                }

                if (
                    !parsed ||
                    !Array.isArray(parsed.questions) ||
                    parsed.questions.length !== count
                ) {
                    throw new Error(
                        `The AI must return exactly ${count} questions. Please retry.`
                    );
                }

                const questions = parsed.questions.map(
                    (question, index) =>
                        validateQuestion(
                            question,
                            index,
                            topic,
                            difficulty
                        )
                );

                console.log(
                    `[aiQuiz] Successfully generated ${count} questions using ${currentModel}.`
                );

                return questions;
            }

            const errorText = await response.text();

            console.error(
                `[aiQuiz] ${currentModel} returned HTTP ${response.status}:`,
                errorText
            );

            if (response.status !== 429) {
                throw new Error(
                    `AI question generation failed (HTTP ${response.status}). Check the backend terminal.`
                );
            }

            lastError = errorText;
            retryDelay = Math.max(
                retryDelay,
                getRetryDelay(errorText)
            );

            console.log(
                `[aiQuiz] Rate limit reached for ${currentModel}.`
            );
        }

        if (round < MAX_RETRY_ROUNDS) {
            console.log(
                `[aiQuiz] All models are rate-limited. Waiting ${Math.ceil(retryDelay / 1000)} seconds before retrying.`
            );

            await sleep(retryDelay);
        }
    }

    console.error("[aiQuiz] All model attempts failed:", lastError);

    throw new Error(
        "Both Groq models are rate-limited. Please wait and try again."
    );
}

async function generateQuestions({ topic, difficulty, count }) {
    if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_QUESTION_COUNT
    ) {
        throw new Error(
            `Question count must be between 1 and ${MAX_QUESTION_COUNT}.`
        );
    }

    if (topic !== "all" && !VALID_TOPICS.includes(topic)) {
        throw new Error(`Invalid quiz topic: ${topic}`);
    }

    if (
        difficulty !== "all" &&
        !VALID_DIFFICULTIES.includes(difficulty)
    ) {
        throw new Error(`Invalid difficulty: ${difficulty}`);
    }

    const allQuestions = [];

    for (
        let start = 0;
        start < count;
        start += BATCH_SIZE
    ) {
        const batchCount = Math.min(
            BATCH_SIZE,
            count - start
        );

        const batchNumber =
            Math.floor(start / BATCH_SIZE) + 1;

        console.log(
            `[aiQuiz] Generating batch ${batchNumber}: ${batchCount} questions`
        );

        const batch = await generateQuestionBatch({
            topic,
            difficulty,
            count: batchCount
        });

        allQuestions.push(
            ...batch.map((question, index) => ({
                ...question,
                id: allQuestions.length + index + 1
            }))
        );

        console.log(
            `[aiQuiz] Generated ${allQuestions.length}/${count} questions`
        );

        if (start + BATCH_SIZE < count) {
            console.log(
                `[aiQuiz] Waiting ${BATCH_DELAY_MS / 1000} seconds before the next batch.`
            );

            await sleep(BATCH_DELAY_MS);
        }
    }

    return allQuestions;
}

module.exports = { generateQuestions };