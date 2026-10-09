'use strict';
// Full-screen scenes: ?mode=starting (default), brb or ending.
(() => {
  const mode = Overlay.params.get('mode') || 'starting';
  const text = {
    starting: ['Starting soon', 'Live: making Minecraft servers on Tree Host'],
    brb: ['Be right back', 'Make a server while you wait'],
    ending: ['Thanks for watching!', 'Your server stays up until the next reset'],
  }[mode] || ['Tree Host', 'Minecraft server hosting'];
  document.getElementById('title').textContent = text[0];
  const tag = document.getElementById('tag');
  tag.firstChild.textContent = text[1];
  if (mode === 'ending') tag.querySelector('.dots').remove();
})();
