import React, { useState, useEffect } from 'react';
import { auth, googleProvider, db } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { 
  doc, setDoc, getDoc, updateDoc, arrayUnion, arrayRemove, 
  onSnapshot, serverTimestamp, collection, query, where, getDocs 
} from 'firebase/firestore';
import { differenceInHours, formatDistanceToNow } from 'date-fns';
import { LogOut, UserPlus, Users, Check, X } from 'lucide-react';

export default function App() {
  const [user, setUser] = useState(null);
  const [isInLibrary, setIsInLibrary] = useState(false);
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]); // Pending requests
  const [friendEmail, setFriendEmail] = useState('');
  const [view, setView] = useState('home'); // 'home' or 'add-friends'
  const [locationNote, setLocationNote] = useState('');

  // --- 1. LOGIN & AUTO-CORRECT LOGIC ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
          // New User Setup
          await setDoc(userRef, {
            email: currentUser.email.toLowerCase(),
            displayName: currentUser.displayName,
            photoURL: currentUser.photoURL,
            isInLibrary: false,
            friends: [],
            requests: []
          });
        } else {
          // EXISTING USER: CHECK STALE STATUS
          const data = userSnap.data();
          let currentStatus = data.isInLibrary;

          if (currentStatus && data.lastCheckIn) {
            const hoursSinceCheckIn = differenceInHours(new Date(), data.lastCheckIn.toDate());
            
            // FIX: If > 4 hours, force update to FALSE immediately
            if (hoursSinceCheckIn >= 4) {
              await updateDoc(userRef, { isInLibrary: false, lastCheckIn: null });
              currentStatus = false;
            }
          }
          setIsInLibrary(currentStatus);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // --- 2. DATA LISTENER ---
  useEffect(() => {
    if (!user) return;
    
    // Listen to MY user doc (for request list & friend IDs)
    const unsubUser = onSnapshot(doc(db, 'users', user.uid), async (docSnap) => {
      const data = docSnap.data();
      if (!data) return;
      
      setRequests(data.requests || []);
      const friendIds = data.friends || [];
      
      // If we have friends, fetch their live status
      if (friendIds.length > 0) {
        // Firestore 'in' query supports max 10 items. For prod, split into chunks.
        const q = query(collection(db, 'users'), where('email', 'in', friendIds));
        const unsubFriends = onSnapshot(q, (snapshot) => {
          setFriends(snapshot.docs.map(d => d.data()));
        });
      } else {
        setFriends([]);
      }
    });
    return () => unsubUser();
  }, [user]);

  // --- ACTIONS ---
  const handleLogin = async () => {
    try { await signInWithPopup(auth, googleProvider); } catch (e) { console.error(e); }
  };

  const toggleStatus = async () => {
    if (!user) return;
    const newState = !isInLibrary;
    setIsInLibrary(newState);
    await updateDoc(doc(db, 'users', user.uid), {
      isInLibrary: newState,
      lastCheckIn: newState ? serverTimestamp() : null,
      statusNote: newState ? locationNote : ""
    });
  };

  const sendFriendRequest = async () => {
    if (!friendEmail) return;
    const cleanEmail = friendEmail.trim().toLowerCase(); // <--- THE FIX
    
    // 1. Check if trying to add self
    if (cleanEmail === user.email) {
      alert("you can't add yourself!");
      return;
    }

    try {
      const q = query(collection(db, 'users'), where('email', '==', cleanEmail));
      const querySnapshot = await getDocs(q);
      
      if (querySnapshot.empty) {
        alert('user not found! double check the spelling or ask them to sign in first.');
        return;
      }

      const targetUser = querySnapshot.docs[0];
      
      // 2. Check if already friends
      if (targetUser.data().friends?.includes(user.email)) {
        alert("you are already friends!");
        return;
      }

      await updateDoc(doc(db, 'users', targetUser.id), { 
        requests: arrayUnion(user.email) 
      });
      
      alert(`request sent to ${cleanEmail}!`);
      setFriendEmail('');

    } catch (error) {
      console.error(error);
      alert("something went wrong. check the console.");
    }
  };

  const acceptRequest = async (requesterEmail) => {
    try {
      // 1. Add them to MY friends & remove request
      await updateDoc(doc(db, 'users', user.uid), {
        friends: arrayUnion(requesterEmail),
        requests: arrayRemove(requesterEmail)
      });

      // 2. Add ME to THEIR friends (Mutual)
      const q = query(collection(db, 'users'), where('email', '==', requesterEmail));
      const snap = await getDocs(q);
      
      if (!snap.empty) {
        await updateDoc(doc(db, 'users', snap.docs[0].id), { 
          friends: arrayUnion(user.email) 
        });
        alert("friend added!");
      }
    } catch (error) {
      console.error(error);
      alert("could not accept friend. check console.");
    }
  };
  // Filter: Ignore friends who have been "Online" for > 4 hours (Visual Fallback)
  const isOnline = (friend) => {
    if (!friend.isInLibrary || !friend.lastCheckIn) return false;
    return differenceInHours(new Date(), friend.lastCheckIn.toDate()) < 4;
  };

  // --- SUGGESTED FRIENDS LOGIC (Mutals) ---
  const getSuggestedFriends = () => {
    // This is a placeholder for the UI. To actually fetch friends-of-friends 
    // without downloading the entire database, we need to query based on our current friends' data.
    // For now, let's set up the array structure so the UI works, and we can wire up the deep-query next.
    return []; 
  };

  // --- RENDER ---
  if (!user) {
    return (
      <div className="h-screen bg-sky-50 flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-4xl font-bold text-sky-400 mb-2">where the hbll are you?</h1>
        <p className="text-slate-400 mb-8">see who's studying.</p>
        <button onClick={handleLogin} className="bg-white px-8 py-3 rounded-full shadow-lg text-sky-500 font-bold hover:shadow-xl transition-all">
          sign in with google
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-slate-600 font-medium">
      {/* Top Bar */}
      <div className="p-6 flex justify-between items-center">
        <h1 className="text-xl text-sky-400 font-bold" onClick={() => setView('home')}>where the hbll are you?</h1>
        <div className="flex gap-4">
          <button onClick={() => setView(view === 'home' ? 'add-friends' : 'home')}>
            {view === 'home' ? <UserPlus size={24} className="text-slate-300" /> : <Users size={24} className="text-slate-300" />}
          </button>
          <button onClick={() => signOut(auth)}><LogOut size={24} className="text-slate-300" /></button>
        </div>
      </div>

      {view === 'home' ? (
        <div className="flex flex-col items-center px-6">
          {/* BIG BUTTON */}
          <button 
            onClick={toggleStatus}
            className={`w-64 h-64 rounded-full flex flex-col items-center justify-center transition-all duration-500 mb-12 shadow-2xl
              ${isInLibrary ? 'bg-sky-400 text-white shadow-sky-200 scale-105' : 'bg-slate-50 text-slate-300 shadow-slate-100'}`}
          >
            <span className="text-3xl font-bold mb-2">{isInLibrary ? "i'm here" : "i'm away"}</span>
            <span className="text-sm opacity-80">{isInLibrary ? "letting people know..." : "tap to join"}</span>
          </button>

          <div className="mt-4 w-full max-w-xs transition-opacity duration-300">
            <input 
              type="text"
              value={locationNote}
              onChange={(e) => setLocationNote(e.target.value.toLowerCase())}
              placeholder="where are you?"
              disabled={isInLibrary} // Lock the note once they are checked in
              className={`w-full bg-transparent border-b border-slate-200 py-2 px-1 text-center outline-none text-slate-400 placeholder-slate-300 text-sm transition-all
                ${isInLibrary ? 'opacity-50 border-transparent' : 'focus:border-sky-200'}`}
            />
          </div>

          {/* Friends List */}
          <div className="w-full max-w-md mt-4">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">who's here</h3>
            {friends.filter(isOnline).length === 0 && <p className="text-center text-slate-300 italic py-4">no one is here yet.</p>}
            
            {friends.filter(isOnline).map(friend => (
              <div key={friend.email} className="flex items-center justify-between bg-sky-50 p-4 rounded-2xl mb-3">
                <div className="flex items-center gap-3 overflow-hidden">
                  <img src={friend.photoURL} className="w-10 h-10 rounded-full flex-shrink-0" alt="avatar" />
                  <div className="flex flex-col leading-tight overflow-hidden">
                    <span className="font-bold text-slate-500">{friend.displayName?.split(' ')[0]}</span>
                    {/* The New Status Note */}
                    {friend.statusNote && (
                      <span className="text-xs text-slate-400 truncate italic">
                        {friend.statusNote}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-sky-400 bg-white px-2 py-1 rounded-full font-bold flex-shrink-0">
                  {formatDistanceToNow(friend.lastCheckIn.toDate())}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="px-6 flex flex-col items-center w-full pb-12">
          
          {/* 1. Add Friend Search */}
          <div className="w-full max-w-md bg-slate-50 p-6 rounded-3xl mb-8 mt-4">
            <h2 className="text-sky-400 mb-4 font-bold">add a friend</h2>
            <div className="flex gap-2">
              <input 
                value={friendEmail}
                onChange={(e) => setFriendEmail(e.target.value.toLowerCase())}
                placeholder="friend's email address"
                className="flex-1 p-3 rounded-xl border-none outline-none text-sm bg-white focus:ring-2 focus:ring-sky-100 transition-all"
              />
              <button onClick={sendFriendRequest} className="bg-sky-400 text-white px-4 rounded-xl font-bold shadow-md shadow-sky-200 hover:scale-105 transition-all">add</button>
            </div>
          </div>

          {/* 2. Pending Requests */}
          {requests.length > 0 && (
            <div className="w-full max-w-md mb-8">
              <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">pending requests</h3>
              {requests.map(reqEmail => (
                <div key={reqEmail} className="flex items-center justify-between bg-white border-2 border-sky-50 p-4 rounded-2xl mb-3 shadow-sm">
                  <span className="text-sm truncate mr-4 font-bold text-slate-500">{reqEmail}</span>
                  <button onClick={() => acceptRequest(reqEmail)} className="bg-sky-100 text-sky-500 p-2 rounded-full hover:bg-sky-400 hover:text-white transition-all">
                    <Check size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 3. Current Friends List (Color/Grayscale sorted) */}
          <div className="w-full max-w-md mb-8">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">your friends</h3>
            {friends.length === 0 && <p className="text-center text-slate-300 italic py-4">no friends yet.</p>}
            
            {/* Sort: Online first, then offline */}
            {[...friends].sort((a, b) => isOnline(b) - isOnline(a)).map(friend => {
              const online = isOnline(friend);
              return (
                <div key={friend.email} className={`flex items-center justify-between p-4 rounded-2xl mb-3 transition-all
                  ${online ? 'bg-sky-50 shadow-sm' : 'bg-slate-50 grayscale-[50%] opacity-60 hover:grayscale-0 hover:opacity-100'}`}>
                  
                  <div className="flex items-center gap-3 overflow-hidden">
                    <img src={friend.photoURL} className="w-10 h-10 rounded-full flex-shrink-0" alt="avatar" />
                    <div className="flex flex-col leading-tight overflow-hidden">
                      <span className="font-bold text-slate-500">{friend.displayName?.split(' ')[0]}</span>
                      {friend.statusNote && online && (
                        <span className="text-xs text-slate-400 truncate italic">
                          {friend.statusNote}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  {online ? (
                    <span className="text-xs text-sky-400 bg-white px-2 py-1 rounded-full font-bold flex-shrink-0">
                      {formatDistanceToNow(friend.lastCheckIn.toDate())}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400 font-bold flex-shrink-0">away</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* 4. Suggested Friends (UI Layout) */}
          <div className="w-full max-w-md opacity-50">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">suggested friends (coming soon)</h3>
            <div className="text-center p-6 border-2 border-dashed border-slate-200 rounded-3xl text-slate-400 text-sm">
              mutual friends algorithm loading...
            </div>
          </div>

        </div>
      )}
    </div>
  );
}