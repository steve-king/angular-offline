# Angular 'Offline' module

Angular 1.x module for monitoring online/offline status and queueing up HTTP requests for when a connection is re-established.

Features:

- Detect Aand display appCache load/progress/complete events so user knows the web app is fully cached and ready for offline use
- Detect changes to online/offline status and notify the user
- Add HTTP POST requests to a queue if the browser is currently offline or when the request fails due to a connection interruption
- Automatically Execute the queue of POST requests whenever a connection is re-established and notify the user





