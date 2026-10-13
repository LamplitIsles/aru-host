# Pending Aru iOS acceptance

Status: **pending**. Use only an isolated CFL test companion with fake official
app-server, a separate adapter state directory and test-owned credentials/images.
No real companion/model/payment/production deployment is authorized by this checklist.
A separate device testing authorization and controlled network are prerequisites.
Server/package tests cannot substitute for any row below.

Record iPhone/iPad model, iOS version, Aru app version/build, package commit/OS,
CFL/contracts pins and the phone→adapter route. Avoid retaining credentials,
private network addresses or chat bodies in shared evidence.

1. Start the two isolated services; encode the operator pairing link locally as QR.
   Scan in Aru. Check single-use/expiry and that exactly one computer collaborator
   appears with CFL name/avatar; one existing conversation appears, with no new
   native session created. Record what unsupported creation/edit UI does.
2. Open existing fixture history; scroll through multiple pages and back down.
   Check stable order, original timestamps, independent completion bubbles and
   labelled reminder/other-channel inputs. Confirm no false empty cognition view.
3. Send text, then send another input during held generation. Check whether the
   released phone UI allows steering; verify CFL sees original start/steer, not a
   second adapter-owned model turn. Complete with multiple bubbles and observe all.
4. Send PNG/JPEG/WebP/GIF, pure image and caption+ordered multiple images. Read/share
   originals and compare hashes. Try bad image/over-limit/file/audio/video; observe
   explicit failure rather than silent omission or an apparent successful send.
5. Send from the existing isolated Lamplit web client and trigger a fixture reminder.
   Check Aru's next polls show both with correct source/identity, without reimport.
6. Stop a held turn; observe confirmed upstream stop. Replay its old stop after a
   new held turn starts; the new turn must continue. Test unavailable stop and retry
   that same turn, with no false confirmation.
7. Drop mobile connectivity and observe continued upstream completion. Restore it;
   check reset/history without duplicates. Inject lost ack; reopen adapter from disk
   and repeat the same clientRequestId, proving lookup and unchanged submit count.
   Unknown/null lookup must remain unresolved without automatic resend.
8. Restart only the adapter; confirm paired node and one conversation identity.
   Revoke the phone credential and check read/send/original download are refused.
9. Observe `/sync` arrival timestamps using a test-only body/credential-free recorder;
   record actual intervals and request duration in foreground active/idle states.
   Do not infer frequency from Console's 650/1500 ms waits. Clear the recorder afterward.

For each row record PASS/FAIL/PENDING with concrete device observations and upstream
fixture effect counts. If Aru rejects an unfamiliar driver or narrowed capability,
report that reproducible behavior before requesting any cross-repository change.
Only device evidence can establish compatibility; live use/deployment remains separate.
