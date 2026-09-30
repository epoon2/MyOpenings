# MyOpenings

A calendar of open and booked time at a link of your own - by day, week or month - for tutors, teachers and anyone who takes bookings. Runs completely on Netlify. The frontend is static, the API uses Netlify Functions, and events are stored in Netlify Blobs.

## Deploy

### Recommended: GitHub + Netlify
1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository.
3. In Netlify, choose **Add new project > Import an existing project** and connect the repository.
4. Netlify will read `netlify.toml` automatically. No build command is required.
5. Deploy the project.

### Required environment variable
After the first project is created, go to **Project configuration > Environment variables** and add:

- `ADMIN_PASSWORD` = the password you want to use for Admin mode

Then trigger a new deploy so the function receives the new environment variable.

Optional variables:
- `PORTAL_TITLE` = e.g. `Ethan Tutoring Availability`
- `TIMEZONE_LABEL` = e.g. `Pacific Time (PT)`
- `DAY_START` = e.g. `8`
- `DAY_END` = e.g. `22`

## Choose a nicer free URL
In Netlify, change the project/site name. Your URL will be:

`https://YOUR-SITE-NAME.netlify.app`

For example:

`https://myopenings.netlify.app`

The exact name must be available.

## How the portal works
- Public visitors see only computed open availability.
- Admin mode shows both availability and private blocked events.
- Private titles and notes are never returned by the public API.
- Public pages refresh automatically every 30 seconds.
- Events can be added, edited, deleted, and dragged on the weekly desktop calendar.
- Data is stored in the site-wide `tutoring-availability` Netlify Blob store. The store's name is an internal key from before the site was called MyOpenings; renaming it would orphan every account and calendar, so it stays.

## Important
Do not put the admin password into `app.js`, `index.html`, GitHub, or `netlify.toml`. Keep it only in Netlify's environment variables.
