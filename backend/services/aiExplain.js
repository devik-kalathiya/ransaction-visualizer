/**
 * AI-assisted explanation service.
 *
 * Uses the Groq API to generate natural-language explanations
 * of the current transaction state and answer DBMS questions.
 *
 * If no key is configured, or the Groq API fails, it falls back
 * to a solid canned explanation so the simulator continues
 * working end-to-end.
 */

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const FALLBACK_EXPLANATIONS = {
  NEW: (ctx) =>
    `Transaction ${ctx.txnCode} has just been created by the DBMS. No operations ` +
    `have executed yet - the system has only allocated a transaction ID and a slot ` +
    `in the transaction table. Under ${ctx.isolation} isolation, no locks or ` +
    `snapshots have been taken at this point.`,

  ACTIVE: (ctx) =>
    `Transaction ${ctx.txnCode} is now ACTIVE and executing its "${ctx.operation}" ` +
    `statements. Each read/write is being logged for recovery purposes. Under ` +
    `${ctx.isolation}, the DBMS is enforcing the concurrency-control rules for that ` +
    `isolation level (e.g. row locks, MVCC snapshots, or predicate locks) while ` +
    `these operations run.`,

  "PARTIALLY COMMITTED": (ctx) =>
    `All statements in ${ctx.txnCode} have executed, but the changes are only in ` +
    `the buffer/cache - they are not yet written to stable storage. The DBMS still ` +
    `has a chance to abort here (e.g. if the final integrity checks fail).`,

  COMMITTED: (ctx) =>
    `${ctx.txnCode} has committed successfully. Per the Durability property of ACID, ` +
    `its changes are now permanent and will survive any subsequent crash, since the ` +
    `commit record has been flushed to the transaction log.`,

  FAILED: (ctx) =>
    `${ctx.txnCode} entered the FAILED state because normal execution could not ` +
    `continue (for example a constraint violation, deadlock, or simulated crash). ` +
    `The DBMS now must undo any partial changes to keep the database consistent.`,

  ABORTED: (ctx) =>
    `The DBMS has rolled back ${ctx.txnCode} using the transaction log: every WRITE ` +
    `it performed has been undone, returning the database to the state it was in ` +
    `before the transaction began.`,

  TERMINATED: (ctx) =>
    `${ctx.txnCode} has left the system. Any locks it held are released and its ` +
    `entry is removed from the active transaction table. This is the final state ` +
    `regardless of whether the transaction committed or aborted.`,
};

function fallbackExplain(ctx) {
  const fn =
    FALLBACK_EXPLANATIONS[ctx.state] ||
    (() => "No explanation available for this state.");

  return fn(ctx);
}

async function explainState(ctx) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return {
      explanation: fallbackExplain(ctx),
      source: "fallback",
    };
  }

  const prompt =
    `You are a DBMS teaching assistant helping a student understand transaction ` +
    `management. Explain, in 2-3 short sentences and plain language, what is ` +
    `happening right now for this transaction:\n\n` +
    `- Transaction ID: ${ctx.txnCode}\n` +
    `- Operation: ${ctx.operation}\n` +
    `- Isolation level: ${ctx.isolation}\n` +
    `- Current state: ${ctx.state}\n` +
    `- Scenario: ${ctx.scenario}\n\n` +
    `Focus on WHY the transaction is in this state and what the DBMS is doing ` +
    `internally (locks, logs, buffers, durability, etc). Do not repeat the raw ` +
    `field values back verbatim; write a natural explanation.`;

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Groq API responded with ${response.status}: ${errorText}`
      );
    }

    const data = await response.json();

    const text =
      data.choices?.[0]?.message?.content?.trim() || "";

    return {
      explanation: text || fallbackExplain(ctx),
      source: "ai",
    };
  } catch (err) {
    // Never let an AI outage break the simulator - degrade gracefully.
    console.error(
      "[aiExplain] falling back to canned explanation:",
      err.message
    );

    return {
      explanation: fallbackExplain(ctx),
      source: "fallback",
      error: err.message,
    };
  }
}

async function askQuestion(ctx, question) {
  const apiKey = process.env.GROQ_API_KEY;

  const contextBlock =
    `Context for reference (only use if relevant to the question):\n` +
    `- Transaction ID: ${ctx.txnCode}\n` +
    `- Operation: ${ctx.operation}\n` +
    `- Isolation level: ${ctx.isolation}\n` +
    `- Current state: ${ctx.state}\n` +
    `- Scenario: ${ctx.scenario}\n\n`;

  const fallbackAnswer =
    `I can't reach the live AI right now (no API key configured, or the request failed), ` +
    `so here's what I can tell you locally: the transaction is currently in the ${ctx.state} state. ` +
    `${
      FALLBACK_EXPLANATIONS[ctx.state]
        ? FALLBACK_EXPLANATIONS[ctx.state](ctx)
        : ""
    }`;

  if (!apiKey) {
    return {
      answer: fallbackAnswer,
      source: "fallback",
    };
  }

  const prompt =
    `You are a DBMS teaching assistant helping a student understand transaction ` +
    `management and databases in general. Answer the student's question clearly ` +
    `and concisely (a few sentences, plain language, examples if useful).\n\n` +
    contextBlock +
    `Student's question: ${question}`;

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Groq API responded with ${response.status}: ${errorText}`
      );
    }

    const data = await response.json();

    const text =
      data.choices?.[0]?.message?.content?.trim() || "";

    return {
      answer: text || fallbackAnswer,
      source: "ai",
    };
  } catch (err) {
    console.error(
      "[askQuestion] falling back:",
      err.message
    );

    return {
      answer: fallbackAnswer,
      source: "fallback",
      error: err.message,
    };
  }
}

module.exports = {
  explainState,
  fallbackExplain,
  askQuestion,
};