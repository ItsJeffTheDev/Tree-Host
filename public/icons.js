'use strict';
// Tree Host's own icons (public/icons.svg). ic('server') -> an inline <svg> that takes the text color and size.
function ic(name, cls = '') {
  return `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="/icons.svg#${name}"/></svg>`;
}
