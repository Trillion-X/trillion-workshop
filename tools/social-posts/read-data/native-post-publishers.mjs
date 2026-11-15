// src/post-publishers.mjs
//
// Purpose: the direct publishers this Worker carries, bound by the names post-place rows use
// (records/post-place-records.json `adapter`). They are the MIT-licensed @opencoredev/social-sdk publishers, each
// posting straight to one place through the person's own connection, and publishers shaped like them for places the
// SDK does not reach (src/post-publisher-substack.mjs). src/social-posts.mjs never imports a publisher:
// it is handed this map, so adding a place is a row here and a row there, and the posting code does not change.
//
// Non-Negotiable Invariants:
//   1. This file only binds names; it holds no token, address or rule.
//   2. `sdk` is the publishing client the publishers plug into (createSocial, connectedAccountRef).
//
import { connectedAccountRef, createSocial } from '@opencoredev/social-sdk';
import { instagram } from '@opencoredev/social-sdk/instagram';
import { linkedin } from '@opencoredev/social-sdk/linkedin';
import { threads } from '@opencoredev/social-sdk/threads';
import { tiktok } from '@opencoredev/social-sdk/tiktok';
import { x } from '@opencoredev/social-sdk/x';
import { youtube } from '@opencoredev/social-sdk/youtube';
import { facebookPage } from './publisher-facebook-page.mjs';
import { substack } from './publisher-substack.mjs';

export const postPublishers = { 'facebook-page': facebookPage, instagram, linkedin, substack, threads, tiktok, x, youtube };
export const postSdk = { createSocial, connectedAccountRef };
