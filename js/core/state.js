export const state = {
  theme: localStorage.getItem('theme') || 'dark',
  pages: ['advanced', 'usage'],
};

export function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('theme', theme);
}
