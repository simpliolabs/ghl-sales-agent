# GHL Appointment Timezone Fix Notes

## Key Finding from GHL API Docs
- `startTime` example: `2021-06-23T03:30:00+05:30` — uses **explicit timezone offset**
- `endTime` example: `2021-06-23T04:30:00+05:30` — same format

## Our Current Code
- We send: `2026-04-15T13:00:00.000Z` (UTC with Z suffix)
- GHL interprets this as UTC and displays in the location's calendar timezone
- The GHL location appears to be set to EST (UTC-5) instead of EDT (UTC-4)
- Result: 13:00 UTC → 8:00 AM EST (instead of 9:00 AM EDT)

## Fix
- Send startTime/endTime with explicit ET offset instead of UTC Z
- April is EDT (UTC-4), so 9:00 AM ET = `2026-04-15T09:00:00-04:00`
- This way GHL knows the exact local time regardless of its timezone setting
- Use America/New_York to compute the correct offset (EST=-05:00, EDT=-04:00)
