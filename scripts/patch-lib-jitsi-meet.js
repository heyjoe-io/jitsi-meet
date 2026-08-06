/* eslint-disable no-console */
/**
 * HeyJoe: patch lib-jitsi-meet's JibriSession.getStatus().
 *
 * WHY
 * ---
 * `start()` sets `_status = 'pending'` on the RECORDING INITIATOR's client only, and
 * upstream `getStatus()` returns `_status` whenever it is set:
 *
 *     getStatus() { if (this._status) { return this._status; } return this._statusFromJicofo; }
 *
 * The only thing that later overwrites `_status` is the jibri's own hidden-domain presence
 * (`_handleJibriPresence` -> `setStatus('on')`), and lib-jitsi-meet DROPS that presence whenever
 * it arrives without a `<session_id>` element — which is what our 11031 box does. Result: the
 * initiator is pinned at 'pending' forever (no recording indicator, no follow-me, and a Record
 * button that can't be cleared without a reload) while every remote participant is fine, because
 * they never call `start()` so their `_status` is empty and they fall through to jicofo's status.
 *
 * Fix: prefer jicofo's status once it has spoken and our own status is still the provisional
 * 'pending'. A real 'on'/'off' from the jibri still wins, so the normal path is unchanged.
 *
 * WHY A SCRIPT AND NOT patch-package
 * ----------------------------------
 * Two artifacts must be patched, and they are NOT interchangeable:
 *   - dist/esm/... — what webpack compiles into app.bundle.min.js
 *   - dist/umd/lib-jitsi-meet.min.js — shipped SEPARATELY by `make deploy-lib-jitsi-meet`
 *     and loaded by index.html. This is the one the browser actually runs.
 * Patching only the esm tree produces a byte-identical app bundle and a completely unfixed
 * client. The umd file is minified onto a single line, so a patch-package diff of it is ~2MB.
 * This script patches both, is idempotent, and EXITS NON-ZERO if either target is missing —
 * a silent no-op here is indistinguishable from a shipped fix that does nothing.
 */

const fs = require('fs');
const path = require('path');

const LJM = path.join(__dirname, '..', 'node_modules', 'lib-jitsi-meet');

const TARGETS = [
    {
        file: path.join(LJM, 'dist', 'esm', 'modules', 'recording', 'JibriSession.js'),
        find: 'if (this._status) {\n            return this._status;\n        }\n        return this._statusFromJicofo;',
        replace: 'if (this._status && !(this._status === \'pending\' && this._statusFromJicofo)) {\n            return this._status;\n        }\n        return this._statusFromJicofo || this._status;',
        done: 'this._status === \'pending\' && this._statusFromJicofo'
    },
    {
        file: path.join(LJM, 'dist', 'umd', 'lib-jitsi-meet.min.js'),
        find: 'getStatus(){return this._status?this._status:this._statusFromJicofo}',
        replace: 'getStatus(){return!this._status||"pending"===this._status&&this._statusFromJicofo?this._statusFromJicofo||this._status:this._status}',
        done: 'getStatus(){return!this._status||"pending"===this._status'
    }
];

let patched = 0;
let already = 0;

for (const t of TARGETS) {
    const rel = path.relative(process.cwd(), t.file);

    if (!fs.existsSync(t.file)) {
        console.error(`[patch-ljm] FAILED: target missing: ${rel}`);
        process.exit(1);
    }

    const src = fs.readFileSync(t.file, 'utf8');

    if (src.includes(t.done)) {
        already++;
        continue;
    }

    if (!src.includes(t.find)) {
        console.error(`[patch-ljm] FAILED: pattern not found in ${rel}.`);
        console.error('[patch-ljm] lib-jitsi-meet probably changed getStatus(). Re-check the fix');
        console.error('[patch-ljm] against the new source before shipping — do NOT ignore this.');
        process.exit(1);
    }

    fs.writeFileSync(t.file, src.replace(t.find, t.replace));
    console.log(`[patch-ljm] patched ${rel}`);
    patched++;
}

console.log(`[patch-ljm] ok — ${patched} patched, ${already} already up to date`);
