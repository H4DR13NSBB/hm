# Duo

A private daily board for two people. Each day has its own section where you both place notes and photos
anywhere you like. At midnight the day locks and a fresh section appears on top. Older days stay below
and scroll back forever.

Static frontend (plain HTML/CSS/JS, no build step) + Supabase (auth, database, photo storage, realtime).
Mobile-first and installable on the iPhone Home Screen.

```
duo/
├── index.html              page markup
├── style.css               styles (auto light/dark)
├── app.js                  all app logic
├── lists.js                Lists tab
├── trips.js                Trips tab
├── mail.js                 Mail tab (postcards)
├── questions.js            Questions tab
├── questions-data.js       the built-in question deck
├── games.js                Games tab
├── sketch.js               Draw & Guess (inside the Games tab)
├── words.js                word of the day (top of the Games tab), language picked in Settings
├── words-data.js           the hand-picked French words (words-nl/de/it/ja.js: the others)
├── words/                  ~3,000 more per language from Wiktionary (made by tools/build-words.mjs)
├── drawing.js              painting pad strokes (board drawings + Draw & Guess)
├── media.js                recording + playing voice notes and videos
├── gifts.js                gift boxes (advent calendar, birthdays, anniversary)
├── push.js                 notifications (in Settings)
├── mock-supabase.js        in-browser demo backend (used until config.js has real keys)
├── config.js               your Supabase URL + anon key
├── manifest.webmanifest    Home Screen app settings
├── sw.js                   service worker (offline shell, only on the real site)
├── icons/                  app icons
├── serve.ps1               tiny local server if you don't use Live Server
└── supabase/
    ├── schema.sql          tables, security rules, storage bucket (run once)
    ├── add-members.sql     registers the two accounts + timezone (run once)
    └── functions/resolve-maps-link/index.ts   opens short Google Maps links (optional)
```

## How the board works

- **Today** is at the top. Tap empty space (or the **+** button) to add a **note**, a **photo**, a **drawing**,
  a **GIF / sticker**, a **voice note** or a **video** at that spot.
- Tap one of **your own** items to select it. Then drag to move it, use **− / +** to resize, ✏️ to edit, or 🗑 to delete.
- Today's section always keeps empty room below the lowest item, so you just keep going down for more space.
- Photos are resized automatically on upload (max 1600 px, ~300 KB) and placed at a sensible size.
- **Voice notes** (up to 3 min) and **videos** (up to 1 min, 30 MB) are recorded in the app, or picked from a file.
  Tap to play; on your own, tap the ▶ (tapping elsewhere selects it). They need the photos Worker (R2).
- **Gift boxes** (🎁 at the top, `gifts.js`): hide a note plus a photo, drawing, GIF, voice note or video in a box
  for the other person to open. Boxes exist on **1–24 December** (an advent calendar: one each per day, with the
  date on the box), on **birthdays** (only the other person gives one) and on the **anniversary** (one each).
  Fill them whenever you like: a box shows up at the top of its day on the board, and only then. What's inside stays
  hidden from the other person (by the database, not just the screen) until they open it, on the day or later.
  You can change or empty your box until it's opened. Birthdays and the anniversary are set in `add-members.sql`.
- **At midnight** (in the timezone you set) today's section locks for both of you, enforced by the database.
  A new empty day appears on top and the board shifts down.
- Each person has their own colour. Positions are stored relative to the board width, so it looks the same on every phone.

## Tabs

- **Board:** the daily board above.
- **Lists:** shared checklists. You start with a "Call topics" list and can add more (**+ New list**).
  Either of you can add, tick, edit (tap the text) or delete items. Each item's circle is in the colour of
  whoever added it. Ticked items fold into **Done**, which you can clear. Code: `lists.js`.
- **Trips** (`trips.js`): trip cards with a countdown. Each trip has:
  - **Plan:** day-by-day timeline (flights, stays, activities, food, transport) with times, booking refs, links and notes.
  - **Ideas:** things you might do, with no day yet. Pick a day in an idea to move it into the plan.
    **Paste a Google Maps link** at the top and the place name and pin are filled in for you.
  - **Map:** everything with a location on OpenStreetMap. Plan items show their day number; ideas have a dashed outline.
  - **Packing:** a checklist for the trip.
  - **Money:** expenses in USD or CHF, split 50/50. Each currency has its own "X owes Y" balance and a **Settle up** button.

- **Questions** (`questions.js`, deck in `questions-data.js`): conversation cards from Wavelength, 216 questions in six
  depths (Surface → Trench, plus Riptide). Pick depths, then swipe right once you've both answered, left to skip,
  or 🔖 to save for later. Answered and saved marks are shared, so new rounds
  leave out what you've already answered together. **Ours** holds questions you write yourselves.
  Only ever add built-in questions at the end of `questions-data.js`: marks are stored by position.

- **Games** (`games.js`): Tic-tac-toe and Connect Four, played live between your two phones. Whoever makes the
  first move is X; after that, the one who was O last time starts. You can only play on your turn (the database
  checks it, one mark at a time), and a badge on the tab shows when it's your move. Finished games are kept,
  so each game has a running score. **Start over** abandons a game without counting it.
  **Draw & Guess:** pick one of three words (or your own) and draw it; the other person watches it being
  drawn again stroke by stroke and guesses. After three wrong guesses the first letter is shown. Drawings are
  kept as pen strokes, so once a round is over either of you can **put it on today's board**, with a caption.
  **Word of the day** (`words.js`): a word and its English translation at the top of the tab, with 🔊 to hear it.
  Each of you picks the language in ⚙️ Settings: French (`words-data.js`), Dutch (`words-nl.js`), German
  (`words-de.js`), Italian (`words-it.js`) or Japanese (`words-ja.js`, with the kana and rōmaji reading). Anyone on
  the same language gets the same word each day. **I knew this one** sets it aside (for you, on that device) and
  rolls another. **Save** adds it to a shared "French words" (or "Dutch words", …) list in Lists; **Pin** puts it on
  today's board. After the hand-picked words come the ~3,000 most common others in each language, in `words/<lang>.json`
  (loaded online, then kept for offline). Rebuild those with `node tools/build-words.mjs [fr nl de it ja]`: it streams
  the Wiktionary extract from [kaikki.org](https://kaikki.org) (CC BY-SA; several GB, nothing is saved) and ranks words
  by the [FrequencyWords](https://github.com/hermitdave/FrequencyWords) subtitle lists (MIT). Known words are
  stored by the word itself, so rebuilding doesn't lose anyone's progress.

- **Mail** (`mail.js`): send each other postcards. Each side can have a photo, text or both, on a background
  colour you pick; the back is a classic postcard with your message on the left and a stamp you choose on the right
  (one of the ready-made ones, or your own: any emoji, text, value and colour, or a picture).
  A posted card takes **2 to 15 days** to arrive: the database draws the number from a normal distribution
  (mean 8.5 days, sd 2.2, redrawn if it falls outside 2–15), so it's usually about a week. The recipient can't
  see the card until it arrives, only that "a postcard is somewhere in the post". Once posted it can't be changed
  or taken back. Arrived cards show a **New** badge; the sender sees when it arrived and whether it's been read.
  In demo mode, a **Deliver everything now** button skips the wait.

### Notifications

The ⚙️ button in the top bar opens **Settings**: notifications, language and signing out. Tap **Turn on for this phone**
(on iPhone this only works in the Home Screen app, iOS 16.4 or later), then pick what you want to hear about:

- **New on the board**: batched, at most once every 10 minutes
- **Postcards**: when one arrives
- **Games**: your turn, game over, and Draw & Guess (a new drawing for you, or yours was guessed)
- **Gift boxes**: at 8:00 (board timezone) on the day one is waiting for you
- **Trips: what's next**: 3 h before a flight, 1 h before a train or transport, 30 min before anything else with a time
- **Trips: arriving soon**: 20 min before a flight, train or transport gets in

The choices are per person (all your phones). Board and game notifications are skipped while you have Duo open.
Trip times are read on the phone's own clock, like the Trips tab, so they're right wherever you are
(each phone's timezone is updated when you open Duo).

How it works: the `duo-photos` Worker runs every minute (cron), asks Supabase what's due (`push_due()` in `schema.sql`,
which keeps bookmarks so nothing is sent twice), and sends standard Web Push messages; `sw.js` shows them and opens
the right tab when tapped. Signing out stops notifications to that phone. Not available in demo mode or on Live Server.

Setup, once: rerun `supabase/schema.sql`, then in `cloudflare/`:

```
npx wrangler secret put VAPID_PRIVATE_KEY     # contents of cloudflare/.vapid-private-key (gitignored)
npx wrangler secret put SUPABASE_SECRET_KEY   # Supabase → Project Settings → API Keys → secret key
npx wrangler@4 deploy
```

The public half of the push key pair is `PUSH_PUBLIC_KEY` in `config.js` and `VAPID_PUBLIC_KEY` in `wrangler.toml`
(they must match). To watch it work: `npx wrangler tail` in `cloudflare/`.

### Google Maps links

Full Google Maps links (`google.com/maps/place/...`) work everywhere. Short share links (`maps.app.goo.gl/...`) need the
small helper function in `supabase/functions/resolve-maps-link/`, because a browser can't follow those redirects itself.
Deploy it once: Supabase Dashboard → **Edge Functions** → **Deploy a new function** → name it `resolve-maps-link`
and paste `index.ts`. Without it (and in demo mode) short links fall back to looking the place up by name.

Place lookups ("Find" and automatic pins) use OpenStreetMap's free Nominatim service: the place text you type is sent there.

### GIFs & stickers

Search goes through the `duo-photos` Worker, which holds the GIPHY API key so it never appears in this public repo.
Get a free key at developers.giphy.com (create an **API** app), then in `cloudflare/`:
`npx wrangler secret put GIPHY_KEY` and `npx wrangler@4 deploy`. Also rerun `supabase/schema.sql` in the SQL Editor
(it's safe to run again whenever it changes). The board stores only GIPHY's link, not the file.

## 0. Try it right now (demo mode, no setup)

While `config.js` still has the `YOUR_...` placeholders, the app runs on a fake in-browser backend
(`mock-supabase.js`) with a sample board covering the last three days.

1. In VS Code, right-click `duo/index.html` → **Open with Live Server**.
2. Click **Sign in as Alex**. Open a second tab at the same URL and click **Sign in as Sam**.
3. Add, move and delete things. The other tab updates live.
4. For the phone layout: DevTools (F12) → device toolbar (Ctrl+Shift+M) → pick an iPhone.
5. **Reset** in the banner restores the sample board.

To try it on your real iPhone: set `"liveServer.settings.host": "0.0.0.0"` in VS Code settings, restart Live Server,
and open `http://<your-PC's-IP>:5500/duo/` on the phone (same Wi-Fi). Demo data lives on each device.

## 1. Set up Supabase (~10 min)

1. Create a free project at <https://supabase.com>.
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**.
3. **Authentication → Users → Add user → Create new user**, once for each person
   (email + password, tick *Auto Confirm User*).
4. Edit the emails, names and **timezone** in `supabase/add-members.sql`, then run it.
5. **Authentication → Sign In / Providers** → turn **off** *Allow new users to sign up*.
6. **Project Settings → API**: copy the *Project URL* and the *anon / publishable* key into `config.js`.
   Never use the `service_role` / secret key in the frontend.

Demo mode switches off automatically once real keys are in `config.js`.

## How it's secured

The anon key is public by design. Data is protected by Row Level Security in `schema.sql`:

- Only the two users in `members` can read anything.
- You can only add to **today**, and only move, edit or delete **your own** items, **today**.
  After midnight the database rejects changes to that day.
- Photos live in a **private** bucket, only in your own folder, shown via signed URLs that expire after 1 hour.

## Storage budget

At ~300 KB per photo, Supabase's free 1 GB holds roughly 3,000 photos. So photos can live on
**Cloudflare R2** instead: 10 GB free (~30,000 photos), then ~$0.015/GB-month, with no download fees.

The `duo-photos` Worker in `cloudflare/` checks your Supabase login, only lets the two members in, and keeps photos
private behind signed links that expire after about an hour. Set `PHOTOS_URL` in `config.js` to the Worker's URL to use it.
Leave it empty to keep using Supabase Storage. All storage code in the app is in the `photos` object in `app.js`.

Free Supabase projects pause after ~7 days without activity. Resume from the dashboard.
(With notifications set up, the Worker checks in every minute, which keeps it awake.)
