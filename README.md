# photo-viewer

A small static site that shows a guest the photos from their photo booth session.

The photobooth app takes four photos, prints a strip, and uploads the session's files to a public-read S3 bucket. While the guest is still at the booth it shows a QR code for this site. They scan it, and this page shows their strip, the animated version if there is one, and the individual photos. They can swipe between them and long-press any image to save it.

It is plain HTML, CSS and JavaScript: no build step, no dependencies, no frameworks. It is hosted on GitHub Pages at <https://iangitscode.github.io/photo-viewer/>.

## Defaults you must check

> **These values are placeholders chosen before the AWS setup existed.** Confirm each one matches the photobooth app's upload settings before relying on the site.

| Setting | Default | Where to change it |
| --- | --- | --- |
| S3 bucket name | `iangitscode-photobooth` | `bucket` in [`config.js`](config.js). Also update the bucket name in the bucket policy ARN (see [S3 setup](#s3-setup)). |
| AWS region | `us-east-1` | `region` in [`config.js`](config.js). |
| Image base URL (derived) | `https://iangitscode-photobooth.s3.us-east-1.amazonaws.com` | Built from `bucket` and `region`. To replace it entirely (CloudFront, a custom domain), set `baseUrlOverride` in [`config.js`](config.js). |
| Site URL | `https://iangitscode.github.io/photo-viewer/` | Comes from the GitHub account (`iangitscode`) and repo name (`photo-viewer`), not from any file here. All asset paths are relative, so the site works under any path. The photobooth app's QR code must point at this same URL. |

## URL contract

The booth's QR code links to:

```
https://iangitscode.github.io/photo-viewer/?event=<event>&uuid=<uuid>
```

| Param | Format | Example |
| --- | --- | --- |
| `event` | Slug, `^[A-Za-z0-9_-]{1,64}$` | `smith-wedding_2026` |
| `uuid` | UUID, case-insensitive `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` | `3f2b8c1e-9a4d-4e6f-b123-0c9d8e7f6a5b` |

If either param is missing or doesn't match, the page shows "Scan the QR code at the photo booth to see your photos" and makes no requests to S3. The UUID's case is kept as given, because S3 keys are case-sensitive.

Images are loaded from:

```
<base URL>/<event>/<uuid>/<file>
```

The site can't list the bucket, so it tries a fixed set of files. They are shown in this order:

| # | File | Notes |
| --- | --- | --- |
| 1 | `composite.png` | The printed strip, 565x1730. Always present for a real session. |
| 2 | `motion.gif` | Animated strip, same aspect ratio. Only uploaded when the booth has motion mode on. |
| 3 | `photo-1.jpg` | Individual photo, landscape. |
| 4 | `photo-2.jpg` | |
| 5 | `photo-3.jpg` | |
| 6 | `photo-4.jpg` | Missing when the booth is set to take 3 photos. |

Files that never load are left out. That is how a 3-photo session, or a booth without motion mode, ends up with fewer slides.

## How it behaves

- **Upload race.** The QR code appears while the booth is still uploading, so the page usually loads before the files exist, and the GIF lands several seconds after the strip. The strip is retried with a backoff from 1 s up to 8 s for about 70 s (12 retries), since it decides between the viewer and the error screen. Every other file keeps trying for about 4 minutes (backoff up to 15 s, 20 retries), because on a slow venue uplink the photos and the GIF can land well after the strip. Retries add `?attempt=N` so a cached error response isn't reused.
- **Coming back later.** Whenever the guest returns to the page (switching back to the tab, unlocking their phone, going back to it in history), anything that had been given up on is asked for again. If that was the strip, the page starts over.
- **Loading.** A spinner shows until `composite.png` loads. The viewer then opens on the strip. If the strip still hasn't loaded when its retries run out, the page shows an error with a **Try again** button that restarts everything.
- **Late files.** Every other file becomes a slide as soon as it loads, always at its fixed position. If it lands before the slide the guest is looking at, the view stays on their current slide with no jump. If the guest is mid-swipe, the new slide waits until scrolling stops.
- **Navigation.** Swiping uses native CSS scroll-snap, one slide per swipe. Left and right arrow keys work too, and on devices with a mouse or trackpad there are prev/next buttons. The dots under the photos track the current slide, and tapping a dot jumps to that slide.
- **Privacy.** The page has `noindex` set. Anyone with the link can view a session, so the bucket must not allow listing (see below). Without listing, the UUID can't be guessed.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup: the status screen (message, loading, error) and the viewer. |
| `style.css` | Mobile-first dark styles, the scroll-snap carousel and the dots. |
| `app.js` | Validation, URL building and retry schedule (pure functions at the top), then the loader and carousel. |
| `config.js` | Bucket, region and optional base-URL override. |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is instead of running Jekyll. |

## Deploying

1. Create a repository named `photo-viewer` under the `iangitscode` account. It must be public for GitHub Pages on a free plan.
2. Push this directory to its `main` branch:
   ```sh
   git init -b main
   git add .
   git commit -m "Photo viewer"
   git remote add origin https://github.com/iangitscode/photo-viewer.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch** and **Branch** to `main` / `(root)`, then **Save**.
4. After a minute or so, <https://iangitscode.github.io/photo-viewer/> should show the "Scan the QR code" message.

Pushing to `main` redeploys automatically.

## S3 setup

This site relies on the following bucket configuration:

1. **Key layout.** The booth uploads each session to `<event>/<uuid>/<file>` using the file names above.
2. **Public read for objects.** Add a bucket policy that grants `s3:GetObject`, and nothing else:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PublicReadPhotoboothObjects",
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::iangitscode-photobooth/*"
       }
     ]
   }
   ```
   Change `iangitscode-photobooth` if your bucket is named differently. Don't grant `s3:ListBucket`: without it, nobody can list sessions, and a missing object returns 403 instead of 404, which this site handles the same way.
3. **Block Public Access.** In the bucket's **Permissions → Block public access** settings, turn off the two settings about bucket policies ("...through *new* public bucket policies" and "...through *any* public bucket policies"). If you don't, S3 will refuse the policy above. The two ACL settings can stay on, since nothing here uses ACLs.
4. **No CORS configuration is needed.** Images load through plain `<img>` elements, not `fetch`/XHR.
5. **Content types.** The uploader should set `Content-Type` (`image/png`, `image/gif`, `image/jpeg`). Browsers will usually display images anyway, but correct types make long-press saving and opening an image on its own behave properly.

If you later put CloudFront in front of the bucket, set `baseUrlOverride`. Also make sure 403/404 responses aren't cached for long (set error caching minimum TTL to 0) or include the query string in the cache key, or the retries during the upload race will keep getting the cached error.

## Testing locally

From the repo root:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/?event=test&uuid=3f2b8c1e-9a4d-4e6f-b123-0c9d8e7f6a5b>. Use any event and UUID; `python3 -c "import uuid; print(uuid.uuid4())"` prints a fresh UUID.

With the default `config.js` this loads images from the real bucket, so a made-up session spins for about 70 s and then shows the error screen. To test with local images, temporarily change `config.js` as below, and **don't commit that change**:

1. Set `baseUrlOverride: 'http://localhost:8000/test-s3'`.
2. Put images at `test-s3/test/<uuid>/composite.png`, `test-s3/test/<uuid>/photo-1.jpg`, and so on.

To reproduce the upload race, open the page first and copy files into that folder while it is retrying. Opening <http://localhost:8000/> with no params shows the "Scan the QR code" message.
