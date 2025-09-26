# Workable Job Scraper

This Apify actor scrapes job listings from Workable job boards. It allows you to search for jobs by keyword, location, and posted date, and collects detailed information about each job listing.

## Features

- Search for jobs by keyword
- Filter by location (city, state, country)
- Filter by posted date (last 24 hours, 7 days, 30 days, or anytime)
- Collect detailed job information including title, company, location, description, and posting date
- Limit the number of results to collect

## Input Schema

The actor accepts the following input parameters:

- `keyword` (string, required): Job title or keyword to search for
- `location` (string, optional): Location filter (city, state, country)
- `postedDate` (enum, optional): Posted date filter - options are "24h", "7d", "30d", "anytime"
- `resultsWanted` (integer, required): Number of job listings to fetch

## Output

The actor outputs job listings in the following format:

```json
{
  "jobTitle": "Job title",
  "company": "Company name",
  "location": "Job location",
  "jobDescription": "Full job description",
  "postedDate": "Date when job was posted",
  "jobLink": "URL to apply for the job"
}
```

## Usage

1. Run the actor with your desired input parameters
2. The results will be stored in the default dataset
3. Each job listing is saved as a separate record in the dataset

## Technical Details

- Uses Crawlee with Playwright for reliable browser automation
- Handles dynamic content loading on Workable job search pages
- Implements pagination to collect multiple pages of results
- Includes error handling and retry mechanisms