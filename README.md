# ASCII Studio

## Run locally
    python -m venv venv
    venv\Scripts\activate          (Windows)   or   source venv/bin/activate  (macOS/Linux)
    pip install -r requirements.txt
    python app.py                  -> http://127.0.0.1:5000

## Deploy to Vercel
    npm i -g vercel
    vercel            # preview deployment (first run links the project)
    vercel --prod     # go live
Or push to GitHub and import the repo at vercel.com/new. No build settings needed.

## If you change Tailwind classes in templates/index.html
    npx tailwindcss@3 -i tailwind.input.css -o public/static/css/tailwind.css --content "templates/*.html" --minify

## Layout
    app.py  requirements.txt  tailwind.input.css
    templates/index.html
    public/static/{css,js}/    <- Vercel serves public/ from its CDN
