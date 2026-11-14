# Meeting review tabs

`MeetingReviewTabs` is the shared visual behavior for a recording's private notes, saved result panels, and transcript. The owning screen supplies tab DATA, reads and refreshes saved result words, and supplies management callbacks. Tabs keep notes and transcript mounted so drafts, player context, and the transcript reader survive a switch.

`renderBody(tabId)` lets the owner replace a result tab's saved words with its own view (action items by speaker); `renderTools(tabId)` adds tools under them (summary template choices, copy, export, rating).
