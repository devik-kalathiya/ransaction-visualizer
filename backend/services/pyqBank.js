"use strict";

const allQuestions = require("../data/pyqTransactions");

function shuffle(list) {
    const result = [...list];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * Returns previous-year questions matching the filters (random order),
 * limited to `count`. Returns fewer than `count` if the bank is smaller.
 */
function getPyqQuestions({ topic = "all", difficulty = "all", count = 10 }) {
    const matches = allQuestions.filter(
        (q) =>
            (topic === "all" || q.topic === topic) &&
            (difficulty === "all" || q.difficulty === difficulty)
    );

    return shuffle(matches)
        .slice(0, count)
        .map((q) => ({ ...q, options: [...q.options] }));
}

module.exports = { getPyqQuestions, PYQ_TOTAL: allQuestions.length };
