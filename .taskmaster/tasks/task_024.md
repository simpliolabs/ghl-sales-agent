# Task ID: 24

**Title:** Phase 4: Stripe Integration + Payment Links

**Status:** pending

**Dependencies:** 21

**Priority:** high

**Description:** Run webdev_add_feature stripe. Create payment_links table. Implement createPaymentLink tool for the single brain. Wire Stripe webhook for checkout.session.completed.

**Details:**

createPaymentLink(lead, amount, description) creates a Stripe Checkout Session with metadata.leadId. On payment success webhook: update payment_links status to 'paid', update lead stage to 'won', notify owner. Payment link expires after 24h. Table: payment_links (id, lead_id, stripe_session_id, amount, url, status, created_at, expires_at, paid_at).

**Test Strategy:**

Test payment link creation with mock Stripe. Test webhook handler updates status correctly. Test expired links are handled. Test owner notification fires on payment.
