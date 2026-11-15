# tell-our-own-voice-from-what-was-heard

The old `src/heard-echo.mjs` algorithms are preserved under `read-data/`. `createHeardEcho({ data, tellRows, kindChannels })` takes this account's echo policy, notification rows and current notification channel selector. It keeps both matching rules: contiguous word runs over the recent spoken union, then content words from one nearby notice. Failed or unknown speech receipts cannot become speech evidence.

The Workshop row reads echo and notification settings from caller rows or `record:content-setting:heard-echo` and `record:content-setting:tell-the-person` through the records door. The caller supplies the notices actually kept by its account and the capture time. The answer names matched speech evidence; the inbound owner retains the captured words as generated context.

`ports/heard-echo.json` preserves source provenance; `test/` covers fragments, digit words, unknown/failed receipts, short-window word matching, cross-notice refusal and caller isolation.
