# Task ID: 25

**Title:** Phase 4: Quote Persistence + Appointment Booking

**Status:** pending

**Dependencies:** 24

**Priority:** high

**Description:** Create quotes table for persisting getQuote results. Implement bookAppointment tool using GHL Calendar API.

**Details:**

quotes table: id, lead_id, product, qty, sides, per_unit, total, rush, status (sent/approved/declined/expired), sent_at, expires_at. bookAppointment: POST to GHL /calendars/events with contactId, startTime, title, notes. Updates lead stage to 'appointment_scheduled'. Returns confirmation ID and human-readable slot.

**Test Strategy:**

Test quote persistence after getQuote call. Test bookAppointment creates GHL calendar event. Test lead stage updates correctly. Test appointment confirmation returned to brain.
