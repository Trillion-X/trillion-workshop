# ui/show/error-boundary/

Pure browser-local React error boundary chrome.

It is legal for feature packages to import because it has no addressed reads,
no target invokes, no durable state, and no feature/package vocabulary. It only
catches a React render error inside the caller-provided subtree and paints a
caller-labeled fallback.

Display formatting never prints caller zone labels or raw error messages in the
product surface. The exact zone and error remain in the console log so users see
plain recovery copy while developers keep the failure evidence.
