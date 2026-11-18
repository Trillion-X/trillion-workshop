// Appearance of the shared list comparison presentation. Its words and facts
// come from the list descriptor and rows; no product is styled specially.
export const LIST_PUBLIC_COMPARISON_CSS = `
.page-section--comparison-hero{padding:clamp(3.5rem,8vw,7.5rem) 0 clamp(3rem,6vw,5rem);border-bottom:1px solid var(--page-line)}
.page-section--comparison-hero .page-heading{max-width:16ch;font-size:clamp(3rem,6.7vw,6rem);line-height:1.02;letter-spacing:-.055em}
.page-section--comparison-hero .page-body{max-width:49rem;font-size:clamp(1.18rem,2vw,1.55rem);line-height:1.55;color:var(--page-soft)}
.page-section--comparison-hero .page-actions{justify-content:flex-start;margin-top:2rem}
.page-main:has(>.page-section>.page-prose)>.page-section--comparison-hero:has(.page-image),.page-section--comparison-hero:has(.page-image){max-width:76rem;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"heading image" "body image" "actions image";column-gap:clamp(2rem,5vw,5rem);align-items:start}
.page-section--comparison-hero:has(.page-image) .page-heading{grid-area:heading;max-width:12ch}
.page-section--comparison-hero:has(.page-image) .page-body{grid-area:body}
.page-section--comparison-hero:has(.page-image) .page-actions{grid-area:actions}
.page-section--comparison-hero .page-image{grid-area:image;align-self:center;width:100%;margin:0;border:1px solid var(--page-line);border-radius:1rem;box-shadow:0 2rem 5rem rgba(0,0,0,.22)}
.page-section--comparison-matrix,.page-section--comparison-products,.page-section--comparison-credit,.page-section--comparison-pick,.page-section--comparison-switch,.page-section--comparison-faq,.page-section--comparison-related,.page-section--comparison-sources,.page-section--comparison-directory,.page-section--comparison-directory-compact{padding:clamp(2.8rem,5vw,4.5rem) 0;border-bottom:1px solid var(--page-line)}
.page-section--comparison-matrix .page-heading,.page-section--comparison-products .page-heading,.page-section--comparison-credit .page-heading,.page-section--comparison-pick .page-heading,.page-section--comparison-switch .page-heading,.page-section--comparison-faq .page-heading,.page-section--comparison-related .page-heading,.page-section--comparison-sources .page-heading,.page-section--comparison-directory .page-heading{font-size:clamp(1.9rem,3.4vw,3.2rem);line-height:1.12;letter-spacing:-.035em;max-width:20ch}
.page-section--comparison-matrix .page-prose{max-width:none}
.page-section--comparison-matrix .page-body{display:none}
.page-section--comparison-matrix .doc-table-wrap{margin-top:2.25rem;border-radius:1rem;box-shadow:0 18px 48px rgba(25,25,25,.045)}
.page-section--comparison-matrix .doc-table{font-size:1rem;line-height:1.5}
.page-section--comparison-matrix .doc-table th,.page-section--comparison-matrix .doc-table td{padding:1.2rem 1.35rem;width:37%}
.page-section--comparison-matrix .doc-table th:first-child,.page-section--comparison-matrix .doc-table td:first-child{width:26%;font-weight:700}
.page-section--comparison-products .page-items,.page-section--comparison-pick .page-items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.25rem;margin-top:2rem;border:0}
.page-section--comparison-products .page-item,.page-section--comparison-pick .page-item{border:1px solid var(--page-line);border-radius:1rem;padding:clamp(1.3rem,2vw,2rem);background:var(--page-card);min-width:0}
.page-section--comparison-credit .page-items{grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem 2rem}
.page-section--comparison-credit .page-item{padding:1.1rem 0;border-bottom:1px solid var(--page-line)}
.page-section--comparison-directory .page-items,.page-section--comparison-related .page-items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;margin-top:2rem;border:0}
.page-section--comparison-directory .page-item,.page-section--comparison-related .page-item{border:1px solid var(--page-line);border-radius:1rem;padding:1.35rem;background:var(--page-card);min-width:0}
.page-section--comparison-directory .page-item-actions,.page-section--comparison-related .page-item-actions{opacity:1}
.page-section--comparison-directory-compact .page-items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2rem;margin-top:2rem;border:0}
.page-section--comparison-directory-compact .page-item{min-width:0;padding:0;border:0;background:none}
.page-section--comparison-directory-compact .page-item-actions{display:flex;flex-direction:column;align-items:flex-start;gap:.35rem;opacity:1}
.page-section--comparison-directory-compact .page-item-actions .page-action{border:0;background:none;padding:.25rem 0;text-align:left;white-space:normal;min-height:2.5rem;text-decoration:underline;text-underline-offset:.2em}
.page-section--comparison-directory-compact .page-item-actions .page-action:hover,.page-section--comparison-directory-compact .page-item-actions .page-action:focus-visible{background:none;color:var(--page-ink)}
.page-section--comparison-sources .page-actions{justify-content:flex-start;flex-wrap:wrap}
@media(max-width:48rem){.page-main:has(>.page-section>.page-prose)>.page-section--comparison-hero:has(.page-image),.page-section--comparison-hero:has(.page-image){grid-template-columns:1fr;grid-template-areas:"heading" "body" "actions" "image";row-gap:1.25rem}.page-section--comparison-hero:has(.page-image) .page-heading{max-width:none}.page-section--comparison-hero .page-image{margin-top:.5rem}.page-section--comparison-hero .page-heading{max-width:none}.page-section--comparison-products .page-items,.page-section--comparison-pick .page-items,.page-section--comparison-credit .page-items,.page-section--comparison-directory .page-items,.page-section--comparison-related .page-items,.page-section--comparison-directory-compact .page-items{grid-template-columns:1fr}.page-section--comparison-directory-compact .page-items{gap:1.5rem}.page-section--comparison-matrix .page-body{display:block;font-size:.875rem;margin-top:.75rem;color:var(--page-soft)}.page-section--comparison-matrix .doc-table{min-width:39rem}.page-section--comparison-matrix .doc-table th,.page-section--comparison-matrix .doc-table td{padding:.8rem .9rem}}
`;
