# Task ID: 11

**Title:** Phase 2: Create Prompt Versioning Table

**Status:** pending

**Dependencies:** 10

**Priority:** high

**Description:** Create prompt_versions table with version, template (TEXT), is_active flag, created_at, notes. Database-driven prompt iterations with zero code deploys.

**Details:**

CREATE TABLE prompt_versions (id INT PRIMARY KEY AUTO_INCREMENT, version VARCHAR(20) NOT NULL, template TEXT NOT NULL, is_active BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT). Insert initial v1.0 prompt as first row with is_active=true.

**Test Strategy:**

Verify table creation. Test only one row can be is_active=true at a time (application-level enforcement). Test prompt retrieval returns active version.
