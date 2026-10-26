const themeToggle = document.getElementById("themeToggle");
const root = document.documentElement;

function applyTheme(theme) {
    const selectedTheme =
        theme === "light" ? "light" : "dark";

    root.dataset.theme = selectedTheme;

    if (themeToggle) {
        if (selectedTheme === "dark") {
            themeToggle.textContent = "☀️ Light mode";
            themeToggle.setAttribute(
                "aria-label",
                "Switch to light mode"
            );
        } else {
            themeToggle.textContent = "🌙 Dark mode";
            themeToggle.setAttribute(
                "aria-label",
                "Switch to dark mode"
            );
        }
    }

    try {
        localStorage.setItem("quizArenaTheme", selectedTheme);
    } catch (error) {
        // Theme still works for this page if storage is unavailable.
    }
}

let savedTheme = "dark";

try {
    savedTheme = localStorage.getItem("quizArenaTheme") || "dark";
} catch (error) {
    // Use dark mode as the default.
}

applyTheme(savedTheme);

if (themeToggle) {
    themeToggle.addEventListener("click", () => {
        const currentTheme = root.dataset.theme;

        applyTheme(
            currentTheme === "dark" ? "light" : "dark"
        );
    });
}