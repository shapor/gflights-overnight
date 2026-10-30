# Google Flights Overnight Window

A Chrome extension that lets Google Flights filter departure or arrival times
across midnight ("leave 11 PM – 2 AM") and across several ranges at once
("6-9, 18-22").

## Install

`chrome://extensions` → enable Developer mode → **Load unpacked** → pick this folder.

## Use

On a Google Flights results page, a "Times across midnight" card appears
bottom-right with two sliders over real calendar time, with ticks at each
midnight:

- **Departure** spans the search date and the next day. Drag to e.g.
  "Sat 11 PM – Sun 2 AM".
- **Arrival** spans the departure day through +2. "Sun 11 PM – Mon 2 AM" means
  exactly that. It does not also match 11 PM on other days, which Google's own
  arrival filter does.

The search updates about a second after you release a handle, so you can set
both handles first. Flights from the extra searches are merged in with a blue
left edge. Clicking one opens the search it came from, where it can be booked.
"View more flights" is expanded automatically, both on the page and in the
background searches.

## How it works, and why

Google encodes the search in the `tfs` URL parameter, a base64url protobuf. In
each leg, field 2 is the date, fields 8/9 are the departure hour range and
fields 10/11 the arrival hour range (whole hours, end inclusive). Probing the
server showed these limits:

- A wrapping range (start 23, end 1) is rejected ("Oops, something went wrong").
- An end past 23 is accepted but clamped. A search never spans two dates.
- Repeating the range fields is last-wins, so there is no native multi-range.
- The arrival range is time-of-day only, so it matches +1 and +2 arrivals alike.

So the extension splits each slider window into one piece per calendar day
(departure pieces × arrival pieces). A departure piece after midnight searches the next date. An
arrival piece keeps the date and filters rows by their `+N` arrival marker.
The first piece becomes the page's own search. The others load in hidden
same-origin iframes, and their rendered rows are cloned into the page.

Alternatives considered: calling Google's internal shopping RPC directly. That
gives cleaner data, but its request format is undocumented nested JSON and
breaks more often than the rendered DOM. Opening one tab per piece is simpler,
but loses the single merged list, which was the point.

## Limitations

- Only the first leg (the outbound on round trips) is filtered.
- The panel needs a `tfs` search URL. A search opened from a `?q=` link only
  gets one after you touch any filter or the date.
- Scraping depends on Google's result markup (`ul > li` rows, times like
  `8:40 AM+2`). It will need touch-ups when Google changes the page.
- Merged rows are snapshots. Sorting, filters and "View more flights" in the
  main page don't apply to them.
