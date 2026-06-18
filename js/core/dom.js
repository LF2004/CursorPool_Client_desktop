export const $ = (id) => document.getElementById(id);

export function renderList(targetId, rows, formatter) {
  const target = $(targetId);
  target.innerHTML = rows.length
    ? rows.map((item) => `<div class="list-item">${formatter(item)}</div>`).join('')
    : '<div class="list-item">暂无数据</div>';
}
