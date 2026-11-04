import test from 'node:test';
import assert from 'node:assert/strict';
import {SPACE_MOUNTING,spaceMountingIn,spaceMountingRefusal} from '../../shared-code/src/failure.mjs';

test('a Space being set up is recognised when a command layer added its own sentence after the Space’s words, with the Space’s retry time',()=>{
 const busy=spaceMountingRefusal();
 const decorated=Object.assign(new Error(`${SPACE_MOUNTING} Whether this request was done is not known yet: ask again with request_key "dependency:abc", which answers what it did and never does it twice.`),{retry_after_ms:2500});
 assert.equal(spaceMountingIn(busy),busy,'the plain refusal');
 assert.equal(spaceMountingIn(decorated),decorated,'the refusal with a sentence added');
 const wrapped=Object.assign(new Error('The lifecycle command stopped.'),{cause:decorated});
 assert.equal(spaceMountingIn(wrapped).retry_after_ms,2500,'under another failure, with its own retry time');
});

test('other failures are not taken for a Space being set up',()=>{
 assert.equal(spaceMountingIn(new Error('Resource quota: credit_exhausted')),null);
 assert.equal(spaceMountingIn(new Error(`Not ${SPACE_MOUNTING}`)),null,'the words must start the message');
 assert.equal(spaceMountingIn(null),null);
 assert.equal(spaceMountingIn('text'),null);
});
