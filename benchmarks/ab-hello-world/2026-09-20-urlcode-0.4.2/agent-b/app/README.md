# Hello World with URLCode

Requires Node 22.18+.

    npm install
    npm start

Then open http://127.0.0.1:3000/ (port shown in the server output).
Stop with Ctrl+C. Check the project with `npx urlcode validate --local --project .`.

Files: `urlcode.yaml` declares the `/` route as a `page` handler serving `public/index.html`.
