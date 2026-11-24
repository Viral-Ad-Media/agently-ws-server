"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateEscalation } = require("../lib/escalation-policy");
const caller = text => ({ role: "caller", text });
const assistant = text => ({ role: "assistant", text });
test("first request for a person offers a message before redirecting", () => {
  assert.equal(evaluateEscalation([caller("Can I talk to a physical person?")]).allowed, false);
});
test("an offer alone cannot be treated as the caller accepting a transfer", () => {
  assert.equal(evaluateEscalation([caller("A manager please"), assistant("Can I take a message or arrange a callback?")]).allowed, false);
});
test("insistence after an alternative permits transfer without mandatory contact details", () => {
  assert.equal(evaluateEscalation([assistant("Can I take a message?"), caller("I want to speak to your manager")]).allowed, true);
  assert.equal(evaluateEscalation([caller("I don't want to leave a message. Just transfer me to a person.")]).allowed, true);
});
test("accepting a message or giving a name does not start a transfer", () => {
  for (const text of ["Yes, take a message", "My name is Luqman", "No need for a manager, please take a message"]) {
    // A caller explicitly withdrawing the request must never be transferred.
    assert.equal(evaluateEscalation([assistant("Can I take a message?"), caller(text)]).allowed, false);
  }
});
test("a transfer refusal is respected and a clear later confirmation is accepted", () => {
  for(const text of ["Don't transfer me", "I do not want to speak to your manager"]) assert.equal(evaluateEscalation([assistant("Can I take a message?"),caller(text)]).allowed,false);
  assert.equal(evaluateEscalation([assistant("Can I take a message?"),caller("I want your manager"),assistant("Shall I connect you now?"),caller("Yes")]).allowed,true);
});
test("structured caller choice supports non-English escalation and cannot bypass a refusal", () => {
  const confirmed = { alternatives_offered:true,caller_still_wants_human:true,caller_declined_alternatives:false };
  assert.equal(evaluateEscalation([assistant("Puis-je prendre un message ?"),caller("Non, je veux parler au responsable.")],confirmed).allowed,true);
  assert.equal(evaluateEscalation([caller("Don't transfer me")],confirmed).allowed,false);
  assert.equal(evaluateEscalation([],confirmed).allowed,false);
});
test("an initial request in another language still requires the de-escalation decision", () => {
  assert.equal(evaluateEscalation([caller("Je voudrais parler au responsable.")],{alternatives_offered:false,caller_still_wants_human:true,caller_declined_alternatives:false}).allowed,false);
});

// Owner rule: a message is always offered before a transfer. A polite first
// request ("can I just talk to a manager?") must not skip that offer.
test("a first 'can I just talk to a manager?' still gets the message offer first", () => {
  for (const ask of ["Can I just talk to a manager?", "Connect me to someone now.", "I'd rather speak to a person."]) {
    const result = evaluateEscalation([{ role: "caller", text: ask }]);
    assert.equal(result.allowed, false, ask);
    assert.match(result.message, /offer once to help, take a message, or arrange a callback/);
  }
});

test("refusing the message itself allows the transfer", () => {
  const result = evaluateEscalation([{ role: "caller", text: "No, I don't want to leave a message. Put me through to a manager." }]);
  assert.equal(result.allowed, true);
});
