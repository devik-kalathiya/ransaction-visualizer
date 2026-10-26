"use strict";

/*
 * Previous-year GATE CSE questions on Transactions & Concurrency.
 * Source: "Previous Year Questions: Transaction" (EduRev PDF).
 * Questions that were multiple-select (MSQ) in the original paper are
 * converted to single-choice "which combination" format so they work with
 * the quiz UI.  Image-only tables are rewritten as text sequences.
 */

const G = "GATE CSE";

module.exports = [
    {
        topic: "locks", difficulty: "Medium", source: `${G} 2024 Set 2`,
        question: "Which of the following statements about the Two Phase Locking (2PL) protocol is/are TRUE?\n(a) 2PL permits only serializable schedules\n(b) With 2PL, a transaction always locks the data item being read or written just before every operation and always releases the lock just after the operation\n(c) With 2PL, once a lock is released on any data item inside a transaction, no more locks on any data item can be obtained inside that transaction\n(d) A deadlock is possible with 2PL\n\nSelect the option listing ALL true statements.",
        options: ["(a), (b) and (c)", "(a), (c) and (d)", "(b), (c) and (d)", "(a), (b) and (d)"],
        answer: 1,
        explanation: "(a) true: 2PL allows only (conflict) serializable schedules. (b) false: 2PL does not release a lock right after each operation. (c) true: once the shrinking phase starts no new lock can be acquired. (d) true: two transactions can wait on each other's locks, so basic 2PL is not deadlock-free."
    },
    {
        topic: "acid", difficulty: "Easy", source: `${G} 2024 Set 2`,
        question: "Once the DBMS informs the user that a transaction has been successfully completed, its effect should persist even if the system crashes before all its changes are reflected on disk. This property is called",
        options: ["Durability", "Atomicity", "Consistency", "Isolation"],
        answer: 0,
        explanation: "Durability: changes made by a committed transaction persist even after system failures."
    },
    {
        topic: "schedules", difficulty: "Medium", source: `${G} 2024 Set 1`,
        question: "Consider the read-write schedule S over three transactions T1, T2 and T3 (subscripts are transaction IDs):\nS: r1(z); w1(z); r2(x); r3(y); w3(y); r2(y); w2(x); w2(y)\n\nWhich of the serial schedules (a) T1T2T3, (b) T1T3T2, (c) T3T2T1, (d) T3T1T2 are conflict equivalent to S? Select the option listing ALL of them.",
        options: ["(a), (b) and (c)", "(a), (c) and (d)", "(b), (c) and (d)", "(a), (b) and (d)"],
        answer: 2,
        explanation: "The only conflicts are between T3 and T2 on y (r3(y)→w2(y), w3(y)→r2(y), w3(y)→w2(y)), giving a single edge T3→T2. T1 is independent. The graph is acyclic, so every topological order is equivalent: T1T3T2, T3T1T2 and T3T2T1, i.e. (b), (c), (d)."
    },
    {
        topic: "schedules", difficulty: "Medium", source: `${G} 2022`,
        question: "Let Ri(z) and Wi(z) denote read and write operations on data element z by transaction Ti. Consider the schedule S with four transactions:\nS: R4(x) R2(x) R3(x) R1(y) W1(y) W2(x) W3(y) R4(y)\n\nWhich one of the following serial schedules is conflict equivalent to S?",
        options: ["T1 → T3 → T4 → T2", "T1 → T4 → T3 → T2", "T4 → T1 → T3 → T2", "T3 → T1 → T4 → T2"],
        answer: 0,
        explanation: "Conflicts give: T4→T2 (R4(x),W2(x)), T3→T2 (R3(x),W2(x)), T1→T3 (W1(y),W3(y)), T1→T4 (W1(y),R4(y)), T3→T4 (W3(y),R4(y)). Topological order: T1, T3, T4, T2."
    },
    {
        topic: "schedules", difficulty: "Hard", source: `${G} 2021 Set 2`,
        question: "Let S be the following schedule of operations of three transactions T1, T2 and T3:\nR2(Y), R1(X), R3(Z), R1(Y), W1(X), R2(Z), W2(Y), R3(X), W3(Z)\n\nP: S is conflict-serializable.\nQ: If T3 commits before T1 finishes, then S is recoverable.\n\nWhich one of the following is correct?",
        options: ["Both P and Q are true", "P is true and Q is false", "P is false and Q is true", "Both P and Q are false"],
        answer: 1,
        explanation: "Edges: T1→T2 (R1(Y) before W2(Y)), T1→T3 (W1(X) before R3(X)), T2→T3 (R2(Z) before W3(Z)). No cycle, so P is true. T3 reads X written by T1 (dirty read); if T3 commits before T1 finishes the schedule is not recoverable, so Q is false."
    },
    {
        topic: "schedules", difficulty: "Medium", source: `${G} 2021 Set 1`,
        question: "Let ri(z) and wi(z) denote read and write operations on item z by transaction Ti. Consider two schedules:\nS1: r1(x) r1(y) r2(x) r2(y) w2(y) w1(x)\nS2: r1(x) r2(x) r2(y) w2(y) r1(y) w1(x)\n\nWhich one of the following is correct?",
        options: ["S1 is conflict serializable, and S2 is not", "S1 is not conflict serializable, and S2 is", "Both S1 and S2 are conflict serializable", "Neither S1 nor S2 is conflict serializable"],
        answer: 1,
        explanation: "S1: r1(y)→w2(y) gives T1→T2 and r2(x)→w1(x) gives T2→T1: cycle, not serializable. S2: r2(x)→w1(x) and w2(y)→r1(y) both give T2→T1: no cycle, conflict serializable."
    },
    {
        topic: "recovery", difficulty: "Medium", source: `${G} 2021 Set 1`,
        question: "Suppose a database system crashes again while recovering from a previous crash. Assume checkpointing is not done by the database either during the transactions or during recovery. Which of the following statements is correct?",
        options: ["The same undo and redo list will be used while recovering again", "The system cannot recover any further", "All the transactions that are already undone and redone will not be recovered again", "The database will become inconsistent"],
        answer: 0,
        explanation: "Without checkpoints, recovery relies on the whole log, so the same undo/redo lists are rebuilt. Undo and redo operations are idempotent, so repeating them is safe and the database stays consistent."
    },
    {
        topic: "schedules", difficulty: "Hard", source: `${G} 2020`,
        question: "Consider this schedule of transactions T1 and T2 (RX = Read(X), WX = Write(X)), in time order:\nRA1, RB2, WB2, RC1, RD2, WD1, WC2, WB1, Commit1, Commit2\n\nWhich one of the following schedules is conflict equivalent to it?",
        options: [
            "RB2 WB2 RD2 RA1 RC1 WD1 WB1 WC2 Commit1 Commit2",
            "RA1 RC1 WD1 WB1 RB2 WB2 RD2 WC2 Commit1 Commit2",
            "RA1 RC1 WD1 RB2 WB2 RD2 WB1 WC2 Commit1 Commit2",
            "RB2 WB2 RD2 WC2 RA1 RC1 WD1 WB1 Commit1 Commit2"
        ],
        answer: 0,
        explanation: "The original schedule has a cycle (T1→T2 on C and D, T2→T1 on B), so any serial-looking option (B, D) is out. Option C swaps the conflicting pair W1(D) and R2(D). Option A keeps every conflicting pair in the original order, so it is conflict equivalent."
    },
    {
        topic: "concurrency", difficulty: "Medium", source: `${G} 2019`,
        question: "Consider two statements about database transaction schedules:\nI. Strict two-phase locking protocol generates conflict serializable schedules that are also recoverable.\nII. Timestamp-ordering concurrency control with Thomas' Write Rule can generate view serializable schedules that are not conflict serializable.\n\nWhich statement(s) is/are TRUE?",
        options: ["I only", "II only", "Both I and II", "Neither I nor II"],
        answer: 2,
        explanation: "I: strict 2PL holds exclusive locks until commit/abort, so schedules are conflict serializable and recoverable. II: Thomas' Write Rule ignores obsolete (blind) writes, producing view serializable schedules that need not be conflict serializable."
    },
    {
        topic: "schedules", difficulty: "Hard", source: `${G} 2017 Set 2`,
        question: "Two transactions are given:\nT1: r1(X) w1(X) r1(Y) w1(Y)\nT2: r2(Y) w2(Y) r2(Z) w2(Z)\n\nThe total number of conflict serializable schedules that can be formed by T1 and T2 is",
        options: ["53", "54", "70", "12"],
        answer: 1,
        explanation: "T1→T2 order allows only 1 schedule (the last operation of T1 conflicts with the first of T2). For T2→T1, count placements of w2(Y) in T1's sequence: 15 + 20 + 18 = 53 schedules. Total = 53 + 1 = 54."
    },
    {
        topic: "locks", difficulty: "Hard", source: `${G} 2017 Set 1`,
        question: "Unique timestamps are assigned to each transaction using Lamport's logical clock. T1 holds a lock on resource R and T2 requests a conflicting lock on R. To prevent deadlocks the following rule is used, and a killed transaction is restarted with the same timestamp:\nif TS(T2) < TS(T1) then T1 is killed, else T2 waits.\n\nAssume any transaction that is not killed terminates eventually. Which of the following is TRUE?",
        options: ["The system is both deadlock-free and starvation-free", "The system is deadlock-free, but not starvation-free", "The system is starvation-free but not deadlock-free", "The system is neither deadlock-free nor starvation-free"],
        answer: 0,
        explanation: "This is the Wound-Wait scheme: an older transaction kills (wounds) a younger one. Waiting only goes from younger to older, so no cycle can form (deadlock-free). Because the restarted transaction keeps its original timestamp, it eventually becomes the oldest and cannot starve."
    },
    {
        topic: "recovery", difficulty: "Medium", source: `${G} 2016 Set 2`,
        question: "Consider the database schedule with two transactions T1 and T2:\nS = r2(X); r1(X); r2(Y); w1(X); r1(Y); w2(X); a1; a2\n(ri(Z) = read, wi(Z) = write, ai = abort by Ti)\n\nWhich one of the following statements about S is TRUE?",
        options: ["S is non-recoverable", "S is recoverable, but has a cascading abort", "S does not have a cascading abort", "S is strict"],
        answer: 2,
        explanation: "No transaction reads a value written by an uncommitted transaction (no dirty read), so S is recoverable and has no cascading aborts. It is not strict because T2 writes X after T1's w1(X) before T1 aborts."
    },
    {
        topic: "schedules", difficulty: "Easy", source: `${G} 2016 Set 2`,
        question: "Suppose a database schedule S involves transactions T1,...,Tn. Construct the precedence graph of S with vertices representing the transactions and edges representing the conflicts. If S is serializable, which one of the following orderings of the vertices of the precedence graph is guaranteed to yield a serial schedule?",
        options: ["Topological order", "Depth-first order", "Breadth-first order", "Ascending order of transaction indices"],
        answer: 0,
        explanation: "A topological order exists only for an acyclic graph, and following it gives a serial schedule conflict-equivalent to S. DFS/BFS orders say nothing about serializability, and index order is arbitrary."
    },
    {
        topic: "locks", difficulty: "Medium", source: `${G} 2016 Set 1`,
        question: "Consider the following two-phase locking protocol. A transaction T accesses a set of objects {O1,...,Ok} as follows:\nStep 1. T acquires exclusive locks on O1,...,Ok in increasing order of their addresses.\nStep 2. The required operations are performed.\nStep 3. All locks are released.\n\nThis protocol will",
        options: ["guarantee serializability and deadlock-freedom", "guarantee neither serializability nor deadlock-freedom", "guarantee serializability but not deadlock-freedom", "guarantee deadlock-freedom but not serializability"],
        answer: 0,
        explanation: "All locks are acquired before any is released (2PL), so schedules are serializable. Locks are requested in a global address order, which prevents circular wait, so deadlock cannot occur."
    },
    {
        topic: "acid", difficulty: "Easy", source: `${G} 2016 Set 1`,
        question: "Which one of the following is NOT a part of the ACID properties of database transactions?",
        options: ["Atomicity", "Consistency", "Isolation", "Deadlock-freedom"],
        answer: 3,
        explanation: "ACID stands for Atomicity, Consistency, Isolation and Durability. Deadlock-freedom is not an ACID property."
    },
    {
        topic: "recovery", difficulty: "Medium", source: `${G} 2015 Set 3`,
        question: "Consider the partial schedule S of two transactions T1 and T2, in time order:\n1. read1(A)\n2. write1(A)\n3. read2(C)\n4. write2(C)\n5. read2(B)\n6. write2(B)\n7. read2(A)\n8. commit2\n9. read1(B)\n\nSuppose T1 fails immediately after time instance 9. Which one of the following is correct?",
        options: ["T2 must be aborted and then both T1 and T2 must be re-started to ensure transaction atomicity", "Schedule S is non-recoverable and cannot ensure transaction atomicity", "Only T2 must be aborted and then re-started to ensure transaction atomicity", "Schedule S is recoverable and can ensure atomicity and nothing else needs to be done"],
        answer: 1,
        explanation: "T2 reads A written by T1 (dirty read) and commits before T1 commits. When T1 fails, the committed T2 cannot be undone, so S is non-recoverable and atomicity cannot be ensured."
    },
    {
        topic: "recovery", difficulty: "Medium", source: `${G} 2015 Set 2`,
        question: "Consider a simple checkpointing protocol and the following log:\n(start, T4); (write, T4, y, 2, 3); (start, T1); (commit, T4); (write, T1, z, 5, 7); (checkpoint); (start, T2); (write, T2, x, 1, 9); (commit, T2); (start, T3); (write, T3, z, 7, 2);\n\nIf a crash happens now and the system recovers using both undo and redo, what are the contents of the undo list and the redo list?",
        options: ["Undo: T3, T1; Redo: T2", "Undo: T3, T1; Redo: T2, T4", "Undo: none; Redo: T2, T4, T3, T1", "Undo: T3, T1, T4; Redo: T2"],
        answer: 0,
        explanation: "T1 and T3 are uncommitted at the crash, so they are undone. T2 committed after the checkpoint, so it is redone. T4 committed before the checkpoint, so it needs neither undo nor redo."
    },
    {
        topic: "acid", difficulty: "Easy", source: `${G} 2015 Set 2`,
        question: "The constraint that the sum of the accounts x and y should remain constant is that of",
        options: ["Atomicity", "Consistency", "Isolation", "Durability"],
        answer: 1,
        explanation: "Preserving an integrity constraint such as 'x + y is constant' is the Consistency property. Atomicity helps achieve it but is not the constraint itself."
    },
    {
        topic: "schedules", difficulty: "Medium", source: `${G} 2014 Set 3`,
        question: "Transactions:\nT1: r1(x); r1(Z); w1(x); w1(Z)\nT2: r2(x); r2(Z); w2(Z)\nT3: r3(x); r3(x); w3(Y)\n\nS1: r1(x); r3(Y); r3(x); r2(Y); r2(Z); w3(Y); w2(Z); r1(Z); w1(x); w1(Z)\nS2: r1(x); r3(Y); r2(Y); r3(x); r1(Z); r2(Z); w3(Y); w1(x); w2(Z); w1(Z)\n\nWhich one of the following statements is TRUE?",
        options: ["Only S1 is conflict-serializable", "Only S2 is conflict-serializable", "Both S1 and S2 are conflict-serializable", "Neither S1 nor S2 is conflict-serializable"],
        answer: 0,
        explanation: "S1's precedence graph (T3→T1, T2→T1, T2→T3) has no cycle, so it is conflict serializable. S2's graph contains a cycle between T1 and T2, so it is not."
    },
    {
        topic: "schedules", difficulty: "Medium", source: `${G} 2014 Set 2`,
        question: "Consider the following schedule S of transactions T1, T2, T3, T4, in time order:\nT2: Reads(X)\nT3: Writes(X), Commit\nT1: Writes(X), Commit\nT2: Writes(Y), Reads(Z), Commit\nT4: Reads(X), Reads(Y), Commit\n\nWhich one of the following statements is CORRECT?",
        options: ["S is conflict-serializable but not recoverable", "S is not conflict-serializable but is recoverable", "S is both conflict-serializable and recoverable", "S is neither conflict-serializable nor recoverable"],
        answer: 2,
        explanation: "No transaction reads uncommitted data, so there are no dirty reads and S is recoverable. The precedence graph (T2→T3, T2→T1, T3→T1, T2→T4, T3→T4, T1→T4) is acyclic, so S is conflict serializable."
    },
    {
        topic: "schedules", difficulty: "Easy", source: `${G} 2014 Set 1`,
        question: "Consider four schedules due to three transactions using read and write on a data item x. Which one of them is conflict serializable?",
        options: ["r1(x); r2(x); w1(x); r3(x); w2(x)", "r2(x); r1(x); w2(x); r3(x); w1(x)", "r3(x); r2(x); r1(x); w2(x); w1(x)", "r2(x); w2(x); r3(x); r1(x); w1(x)"],
        answer: 3,
        explanation: "The last option has no interleaving: all operations of T2, then T3, then T1. It is a serial schedule (T2→T3→T1), hence conflict serializable. The others contain cycles."
    },
    {
        topic: "schedules", difficulty: "Medium", source: `${G} 2012`,
        question: "Consider the following transactions with data items P and Q initialized to zero:\nT1: read(P); read(Q); if P = 0 then Q := Q + 1; write(Q)\nT2: read(Q); read(P); if Q = 0 then P := P + 1; write(P)\n\nAny non-serial interleaving of T1 and T2 for concurrent execution leads to",
        options: ["a serializable schedule", "a schedule that is not conflict serializable", "a conflict serializable schedule", "a schedule for which a precedence graph cannot be drawn"],
        answer: 1,
        explanation: "For any non-serial interleaving, e.g. r1(P) r2(Q) r1(Q) r2(P) w1(Q) w2(P), there are conflicts T1→T2 and T2→T1, so the precedence graph has a cycle and the schedule is not conflict serializable."
    },
    {
        topic: "schedules", difficulty: "Medium", source: `${G} 2010`,
        question: "Consider the following schedule for transactions T1, T2 and T3, in time order:\nT1: Read(X)\nT2: Read(Y)\nT3: Read(Y)\nT2: Write(Y)\nT1: Write(X)\nT3: Write(X)\nT2: Read(X)\nT2: Write(X)\n\nWhich one of the following is the correct serialization of the above?",
        options: ["T1 → T3 → T2", "T2 → T1 → T3", "T2 → T3 → T1", "T3 → T1 → T2"],
        answer: 0,
        explanation: "Edges in the precedence graph: T1→T3, T1→T2, T3→T2. A topological sort gives T1 → T3 → T2."
    },
    {
        topic: "concurrency", difficulty: "Medium", source: `${G} 2010`,
        question: "Which of the following concurrency control protocols ensure both conflict serializability and freedom from deadlock?\nI. 2-phase locking\nII. Time-stamp ordering",
        options: ["I only", "II only", "Both I and II", "Neither I nor II"],
        answer: 1,
        explanation: "Basic 2PL can deadlock. Timestamp ordering never makes a transaction wait (it aborts and restarts instead), so it is deadlock-free while still ensuring conflict serializability."
    }
];
