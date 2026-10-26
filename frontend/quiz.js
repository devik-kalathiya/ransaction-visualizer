const $ = (id) => document.getElementById(id);

const setupSection = $("quiz-setup");
const quizSection = $("quizSection");
const resultSection = $("resultSection");
const reviewContainer = $("reviewContainer");

const quizForm = $("quizForm");
const startQuizBtn = $("startQuizBtn");

const examSelect = $("exam");
const topicSelect = $("topic");
const difficultySelect = $("difficulty");
const questionCountSelect = $("questionCount");
const minutesSelect = $("minutes");
const shuffleSelect = $("shuffle");

let questions = [];
let currentQuestionIndex = 0;
let userAnswers = [];
let timeRemaining = 0;
let timerInterval = null;
let quizSubmitted = false;
let currentQuizSettings = {};

function setVisible(element, visible) {
    if (!element) return;

    element.hidden = !visible;
    element.classList.toggle("hidden", !visible);
}

/* ---------- Batched quiz generation (deployment-safe) ---------- */
const QUIZ_BATCH_SIZE = 5;
const QUIZ_BATCH_DELAY_MS = 8000; /* keeps the AI provider under its rate limit */

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postQuizBatch(payload) {
    const response = await fetch("/api/quiz/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error("The server returned an invalid response.");
    }

    if (!response.ok) {
        throw new Error(
            data.error || data.message || "Failed to generate the quiz."
        );
    }

    return data;
}

async function fetchQuizQuestions({ topic, difficulty, count, exam }) {
    const button = document.getElementById("startQuizBtn");
    const all = [];
    const seen = new Set();
    let source = "AI-generated";

    function add(list) {
        for (const q of list || []) {
            const key = String(q.question || "").trim().toLowerCase();

            if (!key || seen.has(key)) continue;

            seen.add(key);
            all.push(q);
        }
    }

    function progress() {
        if (button) {
            button.textContent = `Generating Quiz... ${all.length}/${count}`;
        }
    }

    /* GATE PYQs (and the PYQ half of mixed) come from the local bank: one fast request. */
    if (exam === "gate" || exam === "mixed") {
        const pyqWanted = exam === "mixed" ? Math.ceil(count / 2) : count;
        const data = await postQuizBatch({
            topic,
            difficulty,
            count: pyqWanted,
            exam: "gate"
        });

        add(data.questions);
        source = data.source;
        progress();

        if (exam === "gate") {
            return { source, questions: all };
        }
    } else if (exam !== "ai") {
        /* e.g. UGC NET: let the server explain that it is unavailable. */
        const data = await postQuizBatch({ topic, difficulty, count, exam });
        return data;
    }

    /* AI questions, 5 at a time. */
    const aiWanted = count - all.length;
    let aiGot = 0;
    let first = true;

    while (aiGot < aiWanted) {
        if (!first) await wait(QUIZ_BATCH_DELAY_MS);
        first = false;

        const batchCount = Math.min(QUIZ_BATCH_SIZE, aiWanted - aiGot);

        try {
            const data = await postQuizBatch({
                topic,
                difficulty,
                count: batchCount,
                exam: "ai"
            });

            const before = all.length;
            add(data.questions);
            aiGot += batchCount; /* advance even if duplicates were dropped */
            progress();

            if (all.length === before && !data.questions?.length) break;
        } catch (error) {
            /* Mixed mode falls back to what we already have; AI-only needs at least one batch. */
            if (all.length === 0) throw error;
            console.warn("Quiz batch failed, using questions so far:", error.message);
            break;
        }
    }

    if (all.length === 0) {
        throw new Error("No questions were returned by the server.");
    }

    if (exam === "mixed") {
        source = "AI + GATE CSE PYQ";
    }

    all.forEach((q, i) => { q.id = i + 1; });

    return { source, questions: all };
}

function showMessage(elementId, message) {
    const element = $(elementId);

    if (!element) {
        alert(message);
        return;
    }

    element.textContent = message;
    element.classList.remove("hidden");
}

function clearMessages() {
    ["setupMessage", "quizMessage"].forEach((id) => {
        const element = $(id);

        if (element) {
            element.textContent = "";
            element.classList.add("hidden");
        }
    });
}

function stopTimer() {
    if (timerInterval !== null) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimer() {
    const timer = $("timer");

    if (!timer) return;

    if (timeRemaining <= 0) {
        timer.textContent = "00:00";
        return;
    }

    const minutes = Math.floor(timeRemaining / 60);
    const seconds = timeRemaining % 60;

    timer.textContent =
        `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    const timerBox = $("timerBox");

    if (timerBox) {
        timerBox.classList.toggle("timer-warning", timeRemaining <= 60);
    }
}

function startTimer() {
    stopTimer();

    const timerBox = $("timerBox");

    if (timeRemaining <= 0) {
        if ($("timer")) {
            $("timer").textContent = "No limit";
        }

        if (timerBox) {
            timerBox.classList.remove("timer-warning");
        }

        return;
    }

    updateTimer();

    timerInterval = setInterval(() => {
        timeRemaining--;
        updateTimer();

        if (timeRemaining <= 0) {
            stopTimer();
            submitQuiz(true);
        }
    }, 1000);
}

function shuffleArray(array) {
    const result = [...array];

    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
}

function formatLabel(value) {
    if (!value) return "";

    return value
        .replace(/[_-]/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getTopicLabel() {
    return topicSelect?.selectedOptions[0]?.textContent.trim() || "All Topics";
}

function getDifficultyLabel() {
    return difficultySelect?.selectedOptions[0]?.textContent.trim() || "All Levels";
}

function getSourceLabel() {
    return examSelect?.selectedOptions[0]?.textContent.trim() || "AI-Generated";
}

async function generateQuiz(event) {
    if (event) event.preventDefault();

    clearMessages();

    const topic = topicSelect.value;
    const difficulty = difficultySelect.value;
    const count = Number(questionCountSelect.value);
    const minutes = Number(minutesSelect.value);
    const shuffle = shuffleSelect.value === "yes";
    const exam = examSelect.value;

    if (!topic || !difficulty || !exam) {
        showMessage("setupMessage", "Please select all quiz options.");
        return;
    }

    if (!Number.isInteger(count) || count < 1 || count >= 100) {
        showMessage("setupMessage", "Choose between 1 and 100 questions.");
        return;
    }

    if (!Number.isFinite(minutes) || minutes < 0) {
        showMessage("setupMessage", "Select a valid time limit.");
        return;
    }

    startQuizBtn.disabled = true;
    startQuizBtn.textContent = "Generating Quiz...";

    try {
        /*
         * Questions are requested in batches of 5 (one short request per
         * batch) instead of one long request. A single long request gets
         * killed by the timeouts of most hosting platforms.
         */
        const data = await fetchQuizQuestions({
            topic,
            difficulty,
            count,
            exam
        });

        if (!Array.isArray(data.questions) || data.questions.length === 0) {
            throw new Error("No questions were returned by the server.");
        }

        questions = data.questions.map((question, index) => {
            if (
                typeof question.question !== "string" ||
                !Array.isArray(question.options) ||
                question.options.length === 0
            ) {
                throw new Error(`Question ${index + 1} has an invalid format.`);
            }

            const answer = Number(question.answer);

            if (
                !Number.isInteger(answer) ||
                answer < 0 ||
                answer >= question.options.length
            ) {
                throw new Error(
                    `Question ${index + 1} has an invalid correct answer.`
                );
            }

            return question;
        });

        if (shuffle) {
            questions = shuffleArray(questions);
        }

        currentQuizSettings = {
            topic,
            difficulty,
            exam,
            minutes
        };

        currentQuestionIndex = 0;
        userAnswers = new Array(questions.length).fill(null);
        quizSubmitted = false;
        timeRemaining = minutes * 60;

        $("quizTitle").textContent =
            `${getTopicLabel()} Quiz`;

        $("sourceTag").textContent =
            data.source || getSourceLabel();

        $("topicTag").textContent = getTopicLabel();
        $("difficultyTag").textContent = getDifficultyLabel();

        setVisible(setupSection, false);
        setVisible(quizSection, true);
        setVisible(resultSection, false);
        setVisible(reviewContainer, false);

        renderQuestion();
        startTimer();

    } catch (error) {
        console.error("Quiz generation error:", error);

        setVisible(setupSection, true);
        setVisible(quizSection, false);
        setVisible(resultSection, false);

        showMessage(
            "setupMessage",
            error.message ||
            "Could not generate the quiz. Check that your backend is running."
        );
    } finally {
        startQuizBtn.disabled = false;
        startQuizBtn.innerHTML = 'Generate Quiz <span>→</span>';
    }
}

function renderQuestion() {
    if (!questions.length) return;

    const question = questions[currentQuestionIndex];

    $("questionProgress").textContent =
        `Question ${currentQuestionIndex + 1} of ${questions.length}`;

    $("questionText").textContent = question.question;

    $("questionTopic").textContent =
        formatLabel(question.topic || currentQuizSettings.topic) +
        (question.source && question.source !== "AI-generated"
            ? ` · ${question.source}`
            : "");

    $("questionDifficulty").textContent =
        formatLabel(question.difficulty || currentQuizSettings.difficulty);

    const progress = $("progressBar");

    if (progress) {
        progress.style.width =
            `${((currentQuestionIndex + 1) / questions.length) * 100}%`;
    }

    const optionsContainer = $("optionsContainer");
    optionsContainer.innerHTML = "";

    question.options.forEach((option, index) => {
        const label = document.createElement("label");
        label.className = "option";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = "quizOption";
        input.value = index;
        input.checked = userAnswers[currentQuestionIndex] === index;

        input.addEventListener("change", () => {
            userAnswers[currentQuestionIndex] = index;
            updateAnsweredCount();
        });

        const text = document.createElement("span");
        text.textContent = option;

        label.appendChild(input);
        label.appendChild(text);

        if (input.checked) {
            label.classList.add("selected");
        }

        input.addEventListener("change", () => {
            optionsContainer.querySelectorAll(".option").forEach((item) => {
                item.classList.remove("selected");
            });

            label.classList.add("selected");
        });

        optionsContainer.appendChild(label);
    });

    $("prevBtn").disabled = currentQuestionIndex === 0;

    $("nextBtn").textContent =
        currentQuestionIndex === questions.length - 1
            ? "Last Question"
            : "Next →";

    updateAnsweredCount();
    clearQuizMessage();
}

function updateAnsweredCount() {
    const answered = userAnswers.filter((answer) => answer !== null).length;

    $("answeredCount").textContent = `${answered} answered`;
}

function clearQuizMessage() {
    const message = $("quizMessage");

    if (message) {
        message.textContent = "";
        message.classList.add("hidden");
    }
}

function previousQuestion() {
    if (quizSubmitted || currentQuestionIndex <= 0) return;

    currentQuestionIndex--;
    renderQuestion();
}

function nextQuestion() {
    if (quizSubmitted) return;

    if (currentQuestionIndex < questions.length - 1) {
        currentQuestionIndex++;
        renderQuestion();
    } else {
        showMessage(
            "quizMessage",
            "You are on the last question. Submit the quiz when you are ready."
        );
    }
}

function submitQuiz(autoSubmitted = false) {
    if (quizSubmitted || questions.length === 0) return;

    if (!autoSubmitted) {
        const unanswered = userAnswers.filter(
            (answer) => answer === null
        ).length;

        if (
            unanswered > 0 &&
            !confirm(
                `You have ${unanswered} unanswered question(s). Submit anyway?`
            )
        ) {
            return;
        }
    }

    quizSubmitted = true;
    stopTimer();

    let correct = 0;

    questions.forEach((question, index) => {
        if (userAnswers[index] === Number(question.answer)) {
            correct++;
        }
    });

    const total = questions.length;
    const unanswered = userAnswers.filter(
        (answer) => answer === null
    ).length;
    const wrong = total - correct - unanswered;
    const percentage = Math.round((correct / total) * 100);

    $("scorePercent").textContent = `${percentage}%`;
    $("totalQuestions").textContent = total;
    $("correctAnswers").textContent = correct;
    $("wrongAnswers").textContent = wrong;
    $("unansweredCount").textContent = unanswered;

    $("resultTitle").textContent =
        percentage >= 80
            ? "Excellent Performance!"
            : percentage >= 60
                ? "Good Work!"
                : percentage >= 40
                    ? "Keep Practising!"
                    : "More Practice Needed";

    $("resultMessage").textContent = autoSubmitted
        ? "Time is up. Your quiz has been submitted automatically."
        : `You answered ${correct} out of ${total} questions correctly.`;

    setVisible(quizSection, false);
    setVisible(resultSection, true);
    setVisible(reviewContainer, false);
}

function showReview() {
    if (!questions.length) return;

    const reviewList = $("reviewList");
    reviewList.innerHTML = "";

    questions.forEach((question, index) => {
        const item = document.createElement("article");
        item.className = "review-item";

        const title = document.createElement("h3");
        title.textContent = `Question ${index + 1}: ${question.question}`;

        const selected = userAnswers[index];
        const answerIndex = Number(question.answer);

        const yourAnswer = document.createElement("p");
        yourAnswer.textContent = selected === null
            ? "Your answer: Not answered"
            : `Your answer: ${question.options[selected]}`;

        yourAnswer.className =
            selected === null
                ? "review-unanswered"
                : selected === answerIndex
                    ? "review-correct"
                    : "review-wrong";

        const correctAnswer = document.createElement("p");
        correctAnswer.textContent =
            `Correct answer: ${question.options[answerIndex]}`;
        correctAnswer.className = "review-correct";

        item.appendChild(title);
        item.appendChild(yourAnswer);
        item.appendChild(correctAnswer);

        if (question.explanation) {
            const explanation = document.createElement("p");
            explanation.textContent = `Explanation: ${question.explanation}`;
            item.appendChild(explanation);
        }

        reviewList.appendChild(item);
    });

    setVisible(reviewContainer, true);
    reviewContainer.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

function startNewQuiz() {
    stopTimer();

    questions = [];
    userAnswers = [];
    currentQuestionIndex = 0;
    timeRemaining = 0;
    quizSubmitted = false;

    clearMessages();

    setVisible(setupSection, true);
    setVisible(quizSection, false);
    setVisible(resultSection, false);
    setVisible(reviewContainer, false);

    window.scrollTo({
        top: setupSection.offsetTop - 20,
        behavior: "smooth"
    });
}

/* Event listeners */

if (quizForm) {
    quizForm.addEventListener("submit", generateQuiz);
}

$("prevBtn").addEventListener("click", previousQuestion);
$("nextBtn").addEventListener("click", nextQuestion);
$("submitBtn").addEventListener("click", () => submitQuiz(false));
$("reviewBtn").addEventListener("click", showReview);
$("retryBtn").addEventListener("click", startNewQuiz);
$("newQuizBtn").addEventListener("click", startNewQuiz);

$("paperQuizBtn").addEventListener("click", () => {
    examSelect.value = "mixed";
    topicSelect.value = "all";
    difficultySelect.value = "all";

    startNewQuiz();

    window.scrollTo({
        top: setupSection.offsetTop - 20,
        behavior: "smooth"
    });
});

/* Initial page state */

setVisible(setupSection, true);
setVisible(quizSection, false);
setVisible(resultSection, false);
setVisible(reviewContainer, false);

/* PDF preview toggle (Transaction PYQ resource) */

const pdfPreviewBtn = $("pdfPreviewBtn");

if (pdfPreviewBtn) {
    pdfPreviewBtn.addEventListener("click", () => {
        const box = $("pdfPreviewBox");
        const frame = $("pdfPreviewFrame");
        const opening = box.hidden;

        if (opening && !frame.getAttribute("src")) {
            frame.setAttribute("src", frame.dataset.src);
        }

        setVisible(box, opening);
        pdfPreviewBtn.setAttribute("aria-expanded", String(opening));
        pdfPreviewBtn.textContent = opening ? "✕ Hide Preview" : "👁 Preview PDF";

        if (opening) {
            box.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    });
}
