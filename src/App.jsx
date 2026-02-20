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
  const [requests, setRequests] = useState([]); 
  const [friendEmail, setFriendEmail] = useState('');
  const [view, setView] = useState('home'); 
  const [locationNote, setLocationNote] = useState('');
  const [friendPage, setFriendPage] = useState(0);
  const [suggestedPage, setSuggestedPage] = useState(0);
  const [suggestedFriends, setSuggestedFriends] = useState([]);
  const [deletingFriend, setDeletingFriend] = useState(null); 

  // --- 1. LOGIN & AUTO-CORRECT LOGIC ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {
          await setDoc(userRef, {
            email: currentUser.email.toLowerCase(),
            displayName: currentUser.displayName,
            photoURL: currentUser.photoURL,
            isInLibrary: false,
            friends: [],
            requests: []
          });
        } else {
          const data = userSnap.data();
          let currentStatus = data.isInLibrary;

          if (currentStatus && data.lastCheckIn) {
            const hoursSinceCheckIn = differenceInHours(new Date(), data.lastCheckIn.toDate());
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

  // --- 2a. LISTEN TO MY DOC (Requests & Friend Emails) ---
  const [friendEmails, setFriendEmails] = useState([]);

  useEffect(() => {
    if (!user) return;
    const unsub = onSnapshot(doc(db, 'users', user.uid), (docSnap) => {
      const data = docSnap.data();
      if (data) {
        setRequests(data.requests || []);
        // We sort them here so the 'in' query doesn't jump around
        setFriendEmails(data.friends || []); 
      }
    });
    return () => unsub();
  }, [user]);

  // --- 2b. LISTEN TO FRIENDS' DATA ---
  useEffect(() => {
    // Safety Check: if no friends, wipe state and STOP. 
    // This kills the "Ghost Suggestions" bug.
    if (!user || friendEmails.length === 0) {
      setFriends([]);
      return;
    }

    // Firestore 'in' query limit is 30. 
    // Let's grab the first 30 to prevent a crash.
    const cappedEmails = friendEmails.slice(0, 30);

    const q = query(collection(db, 'users'), where('email', 'in', cappedEmails));
    const unsub = onSnapshot(q, (snapshot) => {
      const friendData = snapshot.docs.map(d => d.data());
      setFriends(friendData);
    });

    return () => unsub();
  }, [user, friendEmails]); // This block RE-RUNS as soon as friendEmails changes

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
    const cleanEmail = friendEmail.trim().toLowerCase();
    if (cleanEmail === user.email) {
      alert("you can't add yourself!");
      return;
    }

    try {
      const q = query(collection(db, 'users'), where('email', '==', cleanEmail));
      const querySnapshot = await getDocs(q);
      if (querySnapshot.empty) {
        alert('user not found!');
        return;
      }
      const targetUser = querySnapshot.docs[0];
      if (targetUser.data().friends?.includes(user.email)) {
        alert("you are already friends!");
        return;
      }
      await updateDoc(doc(db, 'users', targetUser.id), { requests: arrayUnion(user.email) });
      alert(`request sent!`);
      setFriendEmail('');
    } catch (error) { console.error(error); }
  };

  const acceptRequest = async (requesterEmail) => {
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        friends: arrayUnion(requesterEmail),
        requests: arrayRemove(requesterEmail)
      });
      const q = query(collection(db, 'users'), where('email', '==', requesterEmail));
      const snap = await getDocs(q);
      if (!snap.empty) {
        await updateDoc(doc(db, 'users', snap.docs[0].id), { friends: arrayUnion(user.email) });
      }
      
      setFriendEmails(prev => [...prev, requesterEmail]);

    } catch (error) { console.error(error); }
  };

  const isOnline = (friend) => {
    if (!friend.isInLibrary || !friend.lastCheckIn) return false;
    return differenceInHours(new Date(), friend.lastCheckIn.toDate()) < 4;
  };

  // --- FINAL REMOVE (MUTUAL SYNC) ---
  const finalRemove = async () => {
    if (!deletingFriend) return;
    const friendEmailToRemove = deletingFriend.email;

    try {
      // 1. Remove from MY doc
      await updateDoc(doc(db, 'users', user.uid), {
        friends: arrayRemove(friendEmailToRemove)
      });

      // 2. Remove from THEIR doc
      const q = query(collection(db, 'users'), where('email', '==', friendEmailToRemove));
      const snap = await getDocs(q);
      if (!snap.empty) {
        await updateDoc(doc(db, 'users', snap.docs[0].id), { 
          friends: arrayRemove(user.email) 
        });
      }
      
      setFriendEmails(prev => prev.filter(e => e !== friendEmailToRemove));

      setDeletingFriend(null); 
    } catch (error) {
      console.error(error);
      alert("could not remove friend.");
    }
  };

  // --- ACTUAL SUGGESTED FRIENDS ALGORITHM ---
  useEffect(() => {
    const calculateSuggested = async () => {
      // 1. CLEARANCE: If you have no friends, you CANNOT have mutuals. 
      if (!user || friendEmails.length === 0) {
        setSuggestedFriends([]);
        return;
      }

      // 2. STABILIZER: Wait for both sides of the DB to finish deleting
      await new Promise(resolve => setTimeout(resolve, 800));

      const usersSnap = await getDocs(collection(db, 'users'));
      let calculatedSuggestions = [];

      usersSnap.forEach(doc => {
        const otherUser = doc.data();
        const otherUserEmail = otherUser.email;

        // Skip self, current friends, or pending requests
        if (
          otherUserEmail === user.email || 
          friendEmails.includes(otherUserEmail) ||
          requests.includes(otherUserEmail)
        ) {
          return;
        }

        const theirFriends = otherUser.friends || []; 
        let mutualCount = 0;

        // 3. THE CRITICAL FIX: 
        // We only count a mutual friend if that person is STILL in myFriendEmails.
        // If we just deleted them, they aren't in this list, so mutualCount stays 0.
        theirFriends.forEach(fEmail => {
          if (friendEmails.includes(fEmail)) {
            mutualCount++;
          }
        });

        if (mutualCount > 0) {
          calculatedSuggestions.push({
            email: otherUserEmail,
            name: otherUser.displayName?.split(' ')[0] || otherUserEmail,
            photoURL: otherUser.photoURL || 'https://via.placeholder.com/40',
            mutuals: mutualCount
          });
        }
      });

      calculatedSuggestions.sort((a, b) => b.mutuals - a.mutuals);
      setSuggestedFriends(calculatedSuggestions);
    };

    calculateSuggested();
  }, [friendEmails, user, requests]); // REMOVED 'friends' as a dependency to prevent loops

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
        <h1 className="text-xl text-sky-400 font-bold cursor-pointer" onClick={() => setView('home')}>where the hbll are you?</h1>
        <div className="flex gap-4">
          <button onClick={() => setView(view === 'home' ? 'add-friends' : 'home')}>
            {view === 'home' ? <UserPlus size={24} className="text-slate-300" /> : <Users size={24} className="text-slate-300" />}
          </button>
          <button onClick={() => signOut(auth)}><LogOut size={24} className="text-slate-300" /></button>
        </div>
      </div>

      {view === 'home' ? (
        <div className="flex flex-col items-center px-6">
          <button 
            onClick={toggleStatus}
            className={`w-64 h-64 rounded-full flex flex-col items-center justify-center transition-all duration-500 mb-12 shadow-2xl
              ${isInLibrary ? 'bg-sky-400 text-white shadow-sky-200 scale-105' : 'bg-slate-50 text-slate-300 shadow-slate-100'}`}
          >
            <span className="text-3xl font-bold mb-2">{isInLibrary ? "i'm here" : "i'm away"}</span>
            <span className="text-sm opacity-80">{isInLibrary ? "letting people know..." : "tap to join"}</span>
          </button>

          <div className="mt-4 w-full max-w-xs">
            <input 
              type="text"
              value={locationNote}
              onChange={(e) => setLocationNote(e.target.value.toLowerCase())}
              placeholder="where are you?"
              disabled={isInLibrary}
              className={`w-full bg-transparent border-b border-slate-200 py-2 px-1 text-center outline-none text-slate-400 placeholder-slate-300 text-sm transition-all
                ${isInLibrary ? 'opacity-50 border-transparent' : 'focus:border-sky-200'}`}
            />
          </div>

          <div className="w-full max-w-md mt-4">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">who's here</h3>
            {friends.filter(isOnline).length === 0 && <p className="text-center text-slate-300 italic py-4">no one is here yet.</p>}
            
            {friends.filter(isOnline).map(friend => (
              <div key={friend.email} className="flex items-center justify-between bg-sky-50 p-4 rounded-2xl mb-3">
                <div className="flex items-center gap-3 overflow-hidden">
                  <img src={friend.photoURL} className="w-10 h-10 rounded-full" alt="avatar" />
                  <div className="flex flex-col leading-tight overflow-hidden">
                    <span className="font-bold text-slate-500">{friend.displayName?.split(' ')[0]}</span>
                    {friend.statusNote && <span className="text-xs text-slate-400 truncate italic">{friend.statusNote}</span>}
                  </div>
                </div>
                <span className="text-xs text-sky-400 bg-white px-2 py-1 rounded-full font-bold">
                  {formatDistanceToNow(friend.lastCheckIn.toDate())}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="px-6 flex flex-col items-center w-full pb-12">
          {/* Add Friend Search */}
          <div className="w-full max-w-md bg-slate-50 p-6 rounded-3xl mb-8 mt-4">
            <h2 className="text-sky-400 mb-4 font-bold">add a friend</h2>
            <div className="flex gap-2">
              <input 
                value={friendEmail}
                onChange={(e) => setFriendEmail(e.target.value.toLowerCase())}
                placeholder="friend's email address"
                className="flex-1 p-3 rounded-xl border-none outline-none text-sm bg-white"
              />
              <button onClick={sendFriendRequest} className="bg-sky-400 text-white px-4 rounded-xl font-bold shadow-md shadow-sky-200">add</button>
            </div>
          </div>

          {/* Pending Requests */}
          {requests.length > 0 && (
            <div className="w-full max-w-md mb-8">
              <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">pending requests</h3>
              {requests.map(reqEmail => (
                <div key={reqEmail} className="flex items-center justify-between bg-white border-2 border-sky-50 p-4 rounded-2xl mb-3 shadow-sm">
                  <span className="text-sm truncate mr-4 font-bold text-slate-500">{reqEmail}</span>
                  <button onClick={() => acceptRequest(reqEmail)} className="bg-sky-100 text-sky-500 p-2 rounded-full hover:bg-sky-400 hover:text-white">
                    <Check size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Current Friends List */}
          <div className="w-full max-w-md mb-8 relative">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">your friends</h3>
            {friends.length === 0 ? (
              <p className="text-center text-slate-300 italic py-4">no friends yet.</p>
            ) : (
              <div className="relative px-2">
                {(() => {
                  const sortedFriends = [...friends].sort((a, b) => isOnline(b) - isOnline(a));
                  const friendsPerPage = 5;
                  const totalPages = Math.ceil(sortedFriends.length / friendsPerPage);
                  const visibleFriends = sortedFriends.slice(friendPage * friendsPerPage, (friendPage + 1) * friendsPerPage);

                  return (
                    <>
                      {friendPage > 0 && (
                        <button onClick={() => setFriendPage(p => p - 1)} className="absolute -left-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md z-10"><ChevronLeft size={20} /></button>
                      )}

                      <div className="min-h-[380px]">
                        {visibleFriends.map(friend => {
                          const online = isOnline(friend);
                          return (
                            <div key={friend.email} className={`group flex items-center justify-between p-4 rounded-2xl mb-3 transition-all
                              ${online ? 'bg-sky-50 shadow-sm' : 'bg-slate-50 opacity-60'}`}>
                              <div className="flex items-center gap-3 overflow-hidden">
                                <img src={friend.photoURL} className="w-10 h-10 rounded-full" alt="avatar" />
                                <div className="flex flex-col leading-tight overflow-hidden">
                                  <span className="font-bold text-slate-500">{friend.displayName?.split(' ')[0]}</span>
                                  {friend.statusNote && online && <span className="text-xs text-slate-400 truncate italic">{friend.statusNote}</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-3">
                                {online ? (
                                  <span className="text-xs text-sky-400 bg-white px-2 py-1 rounded-full font-bold whitespace-nowrap">{formatDistanceToNow(friend.lastCheckIn.toDate())}</span>
                                ) : (
                                  <span className="text-xs text-slate-400 font-bold">away</span>
                                )}
                                <button onClick={() => setDeletingFriend(friend)} className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-red-400 transition-all"><X size={18} /></button>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {friendPage < totalPages - 1 && (
                        <button onClick={() => setFriendPage(p => p + 1)} className="absolute -right-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md z-10"><ChevronRight size={20} /></button>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Suggested Friends */}
          <div className="w-full max-w-md mb-8 relative opacity-80">
            <h3 className="text-slate-300 mb-4 text-sm font-bold ml-2">suggested friends</h3>
            {suggestedFriends.length === 0 ? (
              <p className="text-center text-slate-300 italic py-4">no suggestions.</p>
            ) : (
              <div className="relative px-2">
                {(() => {
                  const itemsPerPage = 5;
                  const totalPages = Math.ceil(suggestedFriends.length / itemsPerPage);
                  const visibleSuggestions = suggestedFriends.slice(suggestedPage * itemsPerPage, (suggestedPage + 1) * itemsPerPage);

                  return (
                    <>
                      {suggestedPage > 0 && (
                        <button onClick={() => setSuggestedPage(p => p - 1)} className="absolute -left-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md z-10"><ChevronLeft size={20} /></button>
                      )}
                      <div className="min-h-[380px]">
                        {visibleSuggestions.map((person, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-white border-2 border-dashed border-slate-200 p-4 rounded-2xl mb-3">
                            <div className="flex items-center gap-3">
                              <img src={person.photoURL} className="w-10 h-10 rounded-full" alt="avatar" />
                              <div className="flex flex-col">
                                <span className="font-bold text-slate-500">{person.name}</span>
                                <span className="text-xs text-slate-400">{person.mutuals} mutual friends</span>
                              </div>
                            </div>
                            <button onClick={() => { setFriendEmail(person.email); setTimeout(sendFriendRequest, 100); }} className="text-xs bg-sky-50 text-sky-500 px-3 py-1.5 rounded-full font-bold">add</button>
                          </div>
                        ))}
                      </div>
                      {suggestedPage < totalPages - 1 && (
                        <button onClick={() => setSuggestedPage(p => p + 1)} className="absolute -right-4 top-1/2 -translate-y-1/2 bg-white rounded-full p-2 shadow-md z-10"><ChevronRight size={20} /></button>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingFriend && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <div className="bg-white w-full max-w-xs rounded-3xl p-6 shadow-2xl">
            <h3 className="text-slate-600 font-bold text-lg text-center mb-2">wait! remove {deletingFriend.displayName?.split(' ')[0]}?</h3>
            <p className="text-slate-400 text-xs text-center mb-6">you'll have to re-add them if you change your mind</p>
            <div className="flex flex-col gap-2">
              <button onClick={() => setDeletingFriend(null)} className="w-full py-3 rounded-xl font-bold text-sky-500 bg-sky-50">nevermind</button>
              <button onClick={finalRemove} className="w-full py-3 rounded-xl font-bold text-red-500">say goodbye</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}