<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1Jt5nW298JNZPfvE3R1TxSS-XgY32ncCh

## Run Locally

**Prerequisites:** Node.js

1.  **Install dependencies:**
    `npm install`
2.  **Configure Environment Variables:** Create a `.env.local` file in the root of your project. This is required for connecting to Firebase and for admin password features. If this file is not present, the app will run in a limited, offline mode and admin passwords will default to "admin".

    ```
    # .env.local

    # Gemini API Key (Optional)
    GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
    
    # Firebase Configuration (Required for multiplayer and data persistence)
    FIREBASE_API_KEY="YOUR_FIREBASE_API_KEY"
    FIREBASE_AUTH_DOMAIN="YOUR_FIREBASE_AUTH_DOMAIN"
    FIREBASE_DATABASE_URL="https://YOUR_PROJECT_ID.firebaseio.com"
    FIREBASE_PROJECT_ID="YOUR_FIREBASE_PROJECT_ID"
    FIREBASE_STORAGE_BUCKET="YOUR_FIREBASE_STORAGE_BUCKET"
    FIREBASE_MESSAGING_SENDER_ID="YOUR_FIREBASE_MESSAGING_SENDER_ID"
    FIREBASE_APP_ID="YOUR_FIREBASE_APP_ID"
    FIREBASE_MEASUREMENT_ID="YOUR_FIREBASE_MEASUREMENT_ID"
    
    # Admin Passwords (Defaults to "admin" if not set)
    RESET_PASSWORD="admin"
    ```

3.  **Run the app:**
    `npm run dev`
