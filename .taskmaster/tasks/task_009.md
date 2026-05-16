# Task ID: 9

**Title:** Phase 1: Build Input Guards

**Status:** pending

**Dependencies:** 5

**Priority:** high

**Description:** Create input-guards.ts with 5 hard guards: AI offline, DNC keyword scan, GHL DND, humanTakeover active, TCPA quiet hours. Plus FB 24hr window channel override.

**Details:**

Guard 1: Check system settings aiOnline flag. Guard 2: Scan last 5 inbound messages for DNC keywords → set humanTakeover. Guard 3: Check GHL DND per-channel. Guard 4: humanTakeover=1 and not expired (< 4h). Guard 5: TCPA quiet hours based on area code timezone → defer to next business hour. Guard 5b: FB channel with expired 24hr window → silently override to SMS.

**Test Strategy:**

Test each guard independently. Test DNC keywords trigger block. Test TCPA defers to correct time. Test FB window override changes channel without blocking. Test expired humanTakeover passes.
