
# Workable Job Scraper (Crawlee + Playwright + Chrome) - TypeScript Apify Actor

This actor scrapes job listings from https://jobs.workable.com/search using Crawlee + Playwright.
It clicks into each job posting and extracts both `descriptionHtml` and `descriptionText`.

## Input (INPUT_SCHEMA.json)
- `keyword` (string, required) - keyword(s) to search
- `location` (string, optional) - location filter
- `postedDate` (enum) - one of `24h`, `7d`, `30d`, `anytime`
- `resultsWanted` (integer) - number of job listings to fetch

## Usage
1. Upload this actor zip to Apify.
2. Run the actor on Apify platform; Apify will install dependencies automatically.
3. Output is saved to the default dataset as JSON.

