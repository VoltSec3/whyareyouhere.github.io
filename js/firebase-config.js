// For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyCpufv-5dtigapz3CpJNPVVWqg6-389PPQ",
    authDomain: "jbaydark.firebaseapp.com",
    databaseURL: "https://jbaydark-default-rtdb.firebaseio.com",
    projectId: "jbaydark",
    storageBucket: "jbaydark.firebasestorage.app",
    messagingSenderId: "209421709957",
    appId: "1:209421709957:web:0ddb9ce0772f477011efec",
    measurementId: "G-HRH3N9VFP4"
  };

// Initialize Firebase (only if not already initialized)
if (typeof firebase !== 'undefined' && (!firebase.apps || !firebase.apps.length)) {
  firebase.initializeApp(firebaseConfig);
}
