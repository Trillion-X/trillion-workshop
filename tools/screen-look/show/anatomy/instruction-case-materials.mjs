// The same instruction stays green; a different question stays warm orange.
export const INSTRUCTION_CASE_CSS=`
.figure-sequence__layer:has(>.instruction-case-view){clip-path:inset(20% 0 0 0)}
.instruction-case__trace path{fill:none;stroke:#306b58;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
.instruction-case__trace .dots{fill:#306b58}
.instruction-case__inspection path{fill:none;stroke:#306b58;stroke-width:2.7;stroke-linecap:round;stroke-linejoin:round}
.instruction-case__inspection .dots{fill:#306b58}
.instruction-case__question{fill:none;stroke:#ad5538;stroke-width:6;stroke-linecap:round;stroke-linejoin:round}
.instruction-case__question-dot{fill:#ad5538}
.instruction-case__help{fill:none;stroke:#ad5538;stroke-width:3;stroke-linecap:round}
.instruction-case__reply path{stroke:#ad5538;stroke-width:4;stroke-linecap:round}
.instruction-case__coupling path{stroke:#8d684d;stroke-width:3;stroke-dasharray:8 6}
.instruction-case__instruction-link path{stroke:#306b58;stroke-width:3;stroke-linecap:round}
`;
