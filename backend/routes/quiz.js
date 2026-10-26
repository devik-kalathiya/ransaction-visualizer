"use strict";

const express = require("express");
const { generateQuestions } = require("../services/aiQuiz");
const { getPyqQuestions } = require("../services/pyqBank");

const router = express.Router();

router.post("/generate", async (req, res) => {
    try {
        const {
            topic = "all",
            difficulty = "all",
            count = 10,
            exam = "ai"
        } = req.body;

        /* ---------- Previous-year questions (GATE CSE bank) ---------- */
        if (exam === "gate" || exam === "mixed") {
            const pyqWanted =
                exam === "mixed" ? Math.ceil(count / 2) : count;

            const pyq = getPyqQuestions({ topic, difficulty, count: pyqWanted });

            if (exam === "gate") {
                if (pyq.length === 0) {
                    return res.status(404).json({
                        error:
                            "No GATE previous-year questions match this topic and difficulty. Try 'All Levels' or another topic."
                    });
                }

                return res.json({
                    source: "GATE CSE PYQ",
                    count: pyq.length,
                    questions: pyq
                });
            }

            /* Mixed: top up with AI questions; fall back to PYQs only. */
            const aiWanted = Math.min(30, count - pyq.length);
            let ai = [];

            if (aiWanted > 0) {
                try {
                    ai = await generateQuestions({
                        topic,
                        difficulty,
                        count: aiWanted
                    });
                } catch (error) {
                    console.error("[quiz] Mixed mode AI part failed:", error.message);
                }
            }

            const questions = [...pyq, ...ai];

            if (questions.length === 0) {
                throw new Error("No questions available for this selection.");
            }

            return res.json({
                source: ai.length ? "AI + GATE CSE PYQ" : "GATE CSE PYQ",
                count: questions.length,
                questions
            });
        }

        /* ---------- UGC NET: no verified question data yet ---------- */
        if (exam === "ugcnet") {
            return res.status(404).json({
                error:
                    "UGC NET questions have not been added yet. Choose GATE CSE PYQs, AI-generated or Mixed."
            });
        }

        /* ---------- AI-generated (original behaviour) ---------- */
        const questions = await generateQuestions({
            topic,
            difficulty,
            count
        });

        res.json({
            source: "AI-generated",
            count: questions.length,
            questions
        });
    } catch (error) {
        console.error("[quiz] Generation failed:", error.message);

        res.status(502).json({
            error: error.message || "Unable to generate quiz questions.",
            retryable: true
        });
    }
});

module.exports = router;
