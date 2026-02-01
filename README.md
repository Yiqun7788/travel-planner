# Travel Planner

A multilingual AI-powered travel planner that generates personalized itineraries using the Gemini API.

## Project Structure
```
travel-planner/
├── index.html            ← Frontend (no API key here)
├── api/
│   └── generate.js       ← Serverless function (API key stays on server)
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```

## Deploy to Vercel

### Step 1: Upload to GitHub
1. Create a new repository on GitHub
2. Upload ALL files from this folder directly (not as a subfolder)
3. Make sure `index.html` and `api/` folder are at the root level

### Step 2: Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **"Add New Project"** → import your repository
3. In **Environment Variables**, add:
   - **Name:** `GEMINI_API_KEY`
   - **Value:** Your Gemini API key (get one free at [Google AI Studio](https://aistudio.google.com/apikey))
4. Click **Deploy**

## Security
- The API key is NEVER in the frontend code or committed to GitHub
- All Gemini API calls go through the serverless `/api/generate` route
