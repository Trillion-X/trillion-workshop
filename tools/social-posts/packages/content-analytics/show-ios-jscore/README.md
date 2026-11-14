# Content Analytics iOS JSCore

This renderer accepts the same serialized model used by the browser surface and
returns screen command JSON. It does not read package data, call owner actions,
or use DOM, React, browser storage, or network APIs.

The empty serialized model uses `Waiting`/`Results are waiting` copy so JSCore
and browser renderers stay aligned.
