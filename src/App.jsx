import React, { useState, useEffect } from 'react';
import { auth, googleProvider, db } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { 
  doc, setDoc, getDoc, updateDoc, arrayUnion, arrayRemove, 
  onSnapshot, serverTimestamp, collection, query, where, getDocs 
} from 'firebase/firestore';
import { differenceInHours, formatDistanceToNow } from 'date-fns';
import { LogOut, UserPlus, Users, Check, ChevronLeft, ChevronRight, X } from 'lucide-react';

export default function App() {
  const [user, setUser] = useState(null);
  const [isInLibrary, setIsInLibrary] = useState(false);
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]); // Pending requests
  const [friendEmail, setFriendEmail] = useState('');
  const [view, setView] = useState('home'); // 'home' or 'add-friends'
  const [locationNote, setLocationNote] = useState('');
  const [friendPage, setFriendPage] = useState(0);
  const [suggestedPage, setSuggestedPage] = useState(0);
  const [suggestedFriends, setSuggestedFriends] = useState([]);
  const [deletingFriend, setDeletingFriend] = useState(null); // Holds the friend object we might delete

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

  const finalRemove = async () => {
    if (!deletingFriend) return;
    
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        friends: arrayRemove(deletingFriend.email)
      });

      const q = query(collection(db, 'users'), where('email', '==', deletingFriend.email));
      const snap = await getDocs(q);
      
      if (!snap.empty) {
        await updateDoc(doc(db, 'users', snap.docs[0].id), { 
          friends: arrayRemove(user.email) 
        });
      }
      setDeletingFriend(null); // Close the popup
    } catch (error) {
      console.error(error);
      alert("could not remove friend.");
    }
  };

  // --- SUGGESTED FRIENDS LOGIC (Mutals) ---
  const getSuggestedFriends = () => {
    // This is a placeholder for the UI. To actually fetch friends-of-friends 
    // without downloading the entire database, we need to query based on our current friends' data.
    // For now, let's set up the array structure so the UI works, and we can wire up the deep-query next.
    return []; 
  };

  // --- ACTUAL SUGGESTED FRIENDS ALGORITHM ---
  useEffect(() => {
    const calculateSuggested = async () => {
      // Don't run if we aren't logged in or have no friends yet
      if (!user || friends.length === 0) return;

      // 1. Get an array of just the emails of your current friends
      const myFriendEmails = friends.map(f => f.email);

      // 2. Fetch all users from the database 
      // (For a campus MVP, fetching the whole users collection is totally fine)
      const usersSnap = await getDocs(collection(db, 'users'));
      
      let calculatedSuggestions = [];

      usersSnap.forEach(doc => {
        const otherUser = doc.data();
        const otherUserEmail = otherUser.email;

        // Skip if it's YOU, or if they are ALREADY your friend
        if (otherUserEmail === user.email || myFriendEmails.includes(otherUserEmail)) {
          return;
        }

        // 3. Look at their friends list (assuming your database stores friends in an array called 'friends')
        const theirFriends = otherUser.friends || []; 
        
        // 4. Count the overlaps (Mutuals)
        let mutualCount = 0;
        theirFriends.forEach(fEmail => {
          if (myFriendEmails.includes(fEmail)) {
            mutualCount++;
          }
        });

        // 5. If you have mutual friends, add them to the list
        if (mutualCount > 0) {
          calculatedSuggestions.push({
            email: otherUserEmail,
            name: otherUser.displayName?.split(' ')[0] || otherUserEmail,
            photoURL: otherUser.photoURL || 'https://via.placeholder.com/40', // Fallback image
            mutuals: mutualCount
          });
        }
      });

      // 6. Sort by highest mutual friends first
      calculatedSuggestions.sort((a, b) => b.mutuals - a.mutuals);

      // 7. Save it to state!
      setSuggestedFriends(calculatedSuggestions);
    };

    calculateSuggested();
  }, [friends, user]);

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

          {/* 3. Current Friends List (Paginated) */}
          <div className="w-full max-w-md mb-8 relative">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">your friends</h3>
            
            {friends.length === 0 ? (
              <p className="text-center text-slate-300 italic py-4">no friends yet.</p>
            ) : (
              <div className="relative px-2">
                {/* Calculate Pagination */}
                {(() => {
                  const sortedFriends = [...friends].sort((a, b) => isOnline(b) - isOnline(a));
                  const friendsPerPage = 5;
                  const totalPages = Math.ceil(sortedFriends.length / friendsPerPage);
                  const visibleFriends = sortedFriends.slice(friendPage * friendsPerPage, (friendPage + 1) * friendsPerPage);

                  return (
                    <>
                      {/* Left Navigation Button */}
                      {friendPage > 0 && (
                        <button 
                          onClick={() => setFriendPage(p => p - 1)}
                          className="absolute -left-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md text-slate-400 hover:text-sky-500 z-10 transition-all"
                        >
                          <ChevronLeft size={20} />
                        </button>
                      )}

                      {/* The 5 Friends */}
                      <div className="min-h-[380px]"> {/* Keeps container height stable so buttons don't jump */}
                        {visibleFriends.map(friend => {
                          const online = isOnline(friend);
                          return (
                            <div key={friend.email} className={`group flex items-center justify-between p-4 rounded-2xl mb-3 transition-all
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

                              {/* --- THE REMOVE BUTTON --- */}
                              <button 
                                onClick={() => setDeletingFriend(friend)} 
                                className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-red-400 transition-all duration-200"
                              >
                                <X size={18} />
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      {/* Right Navigation Button */}
                      {friendPage < totalPages - 1 && (
                        <button 
                          onClick={() => setFriendPage(p => p + 1)}
                          className="absolute -right-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md text-slate-400 hover:text-sky-500 z-10 transition-all"
                        >
                          <ChevronRight size={20} />
                        </button>
                      )}

                      {/* Instagram-style Dot Indicator */}
                      {totalPages > 1 && (
                        <div className="flex justify-center items-center gap-1.5 mt-2">
                          {Array.from({ length: totalPages }).map((_, idx) => (
                            <div 
                              key={idx} 
                              className={`h-1.5 rounded-full transition-all duration-300 ${
                                idx === friendPage ? 'w-4 bg-sky-400' : 'w-1.5 bg-slate-200'
                              }`}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* 4. Suggested Friends List (Paginated) */}
          <div className="w-full max-w-md mb-8 relative opacity-80">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">suggested friends</h3>

            {suggestedFriends.length === 0 ? (
              <p className="text-center text-slate-300 italic py-4">no suggestions right now.</p>
            ) : (
              <div className="relative px-2">
                {(() => {
                  const itemsPerPage = 5;
                  const totalPages = Math.ceil(suggestedFriends.length / itemsPerPage);
                  const visibleSuggestions = suggestedFriends.slice(suggestedPage * itemsPerPage, (suggestedPage + 1) * itemsPerPage);

                  return (
                    <>
                      {/* Left Navigation Button */}
                      {suggestedPage > 0 && (
                        <button 
                          onClick={() => setSuggestedPage(p => p - 1)}
                          className="absolute -left-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md text-slate-400 hover:text-sky-500 z-10 transition-all"
                        >
                          <ChevronLeft size={20} />
                        </button>
                      )}

                      {/* The 5 Suggestions */}
                      <div className="min-h-[380px]">
                        {visibleSuggestions.map((person, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-white border-2 border-dashed border-slate-200 p-4 rounded-2xl mb-3 transition-all hover:border-sky-300 hover:shadow-sm">
                            
                            <div className="flex items-center gap-3">
                              <img src={person.photoURL} className="w-10 h-10 rounded-full" alt="avatar" />
                              <div className="flex flex-col">
                                <span className="font-bold text-slate-500">{person.name}</span>
                                <span className="text-xs text-slate-400">{person.mutuals} mutual friends</span>
                              </div>
                            </div>

                            <button 
                              onClick={() => {
                                setFriendEmail(person.email);
                                setTimeout(sendFriendRequest, 100); 
                              }}
                              className="text-xs bg-sky-50 text-sky-500 px-3 py-1.5 rounded-full font-bold hover:bg-sky-400 hover:text-white transition-all"
                            >
                              add
                            </button>
                          </div>
                        ))}
                      </div>

                      {/* Right Navigation Button */}
                      {suggestedPage < totalPages - 1 && (
                        <button 
                          onClick={() => setSuggestedPage(p => p + 1)}
                          className="absolute -right-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md text-slate-400 hover:text-sky-500 z-10 transition-all"
                        >
                          <ChevronRight size={20} />
                        </button>
                      )}

                      {/* Instagram-style Dot Indicator */}
                      {totalPages > 1 && (
                        <div className="flex justify-center items-center gap-1.5 mt-2">
                          {Array.from({ length: totalPages }).map((_, idx) => (
                            <div 
                              key={idx} 
                              className={`h-1.5 rounded-full transition-all duration-300 ${
                                idx === suggestedPage ? 'w-4 bg-sky-400' : 'w-1.5 bg-slate-200'
                              }`}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

        </div>
      )}

      {/* Custom Delete Confirmation Modal */}
      {deletingFriend && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <div className="bg-white w-full max-w-xs rounded-3xl p-6 shadow-2xl scale-in-center">
            <h3 className="text-slate-600 font-bold text-lg text-center mb-2">
              wait! are you sure you want to remove {deletingFriend.displayName?.split(' ')[0]} as a friend?
            </h3>
            <p className="text-slate-400 text-xs text-center mb-6">
              you'll have to re-add them if you change your mind
            </p>
            
            <div className="flex flex-col gap-2">
              <button 
                onClick={() => setDeletingFriend(null)}
                className="w-full py-3 rounded-xl font-bold text-sky-500 bg-sky-50 hover:bg-sky-100 transition-colors"
              >
                nevermind
              </button>
              <button 
                onClick={finalRemove}
                className="w-full py-3 rounded-xl font-bold text-red-500 hover:text-red-600 transition-colors"
              >
                say goodbye
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}