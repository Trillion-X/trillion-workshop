# activation-pricing/view-model

This folder owns the single package translation from generic terms projection
bytes into a platform-agnostic section model.

React, desktop, browser, iOS JSCore, worker, voice, and CLI consumers all read
the same `ViewSectionModel`. Platform code paints section kinds only; it does
not re-read the projection or decide section order.

