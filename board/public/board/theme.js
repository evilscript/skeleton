// Light or dark before the page draws, so it doesn't flash: the choice the top
// bar's theme button saved, else the system's (board.css follows
// prefers-color-scheme when there is no data-theme).
try {
  const theme = localStorage.getItem("board.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
