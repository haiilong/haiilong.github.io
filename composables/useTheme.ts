export const useTheme = () => {
  const theme = useState<"light" | "dark">("theme", () => "light");

  const syncFromDom = () => {
    if (import.meta.client) {
      theme.value =
        document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    }
  };

  const toggle = () => {
    const next = theme.value === "light" ? "dark" : "light";
    theme.value = next;
    if (import.meta.client) {
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("theme", next);
      } catch {}
    }
  };

  return { theme, toggle, syncFromDom };
};
