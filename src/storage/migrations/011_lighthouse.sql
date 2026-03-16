-- Lighthouse audit scores per site
ALTER TABLE sites ADD COLUMN lighthouse_score REAL;
ALTER TABLE sites ADD COLUMN lighthouse_accessibility REAL;
