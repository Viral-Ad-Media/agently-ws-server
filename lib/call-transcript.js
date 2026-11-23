"use strict";

// A transfer can stop one media stream and start another on the same call.
// Saving the new stream must not erase earlier AI turns or recording speech.
function mergeCallTranscript(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const line of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!line?.text) continue;
    const key = JSON.stringify([line.recording_sid || "", line.ts || line.at || "", line.role || line.speaker || "", line.text]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

module.exports = { mergeCallTranscript };
