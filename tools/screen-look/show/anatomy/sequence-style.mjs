export const SEQUENCE_CSS = `
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--anatomy-page)}
.figure-sequence{--anatomy-mono:var(--font-primary,"Inter Variable",Inter,sans-serif);position:relative;width:100dvw;height:100dvh;overflow:hidden;container-type:size}
.figure-sequence>.scene{position:absolute;inset:0;background:transparent;pointer-events:none}
.figure-sequence__layer{position:absolute;inset:0;transform-origin:50% 50%}
.figure-sequence__layer>svg{width:100%;height:100%;display:block}
.figure-sequence__layer[data-native]{inset:auto;left:0;top:0;transform-origin:0 0}
`;
