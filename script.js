// --- Firebase Config ---
const firebaseConfig = {
    apiKey: "AIzaSyDwGzTPmFg-gjoYtNWNJM47p22NfBugYFA",
    authDomain: "mock-test-1eea6.firebaseapp.com",
    databaseURL: "https://mock-test-1eea6-default-rtdb.firebaseio.com",
    projectId: "mock-test-1eea6",
    storageBucket: "mock-test-1eea6.firebaseapp.com",
    messagingSenderId: "111849173136",
    appId: "1:111849173136:web:8b211f58d854119e88a815",
    measurementId: "G-5RLWPTP8YD"
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// --- Globals ---
let questions = [];
let currentIdx = 0;
let status, userAnswers;
let isSubmitted = false;
let timerInterval;
let timeLeft = 90 * 60; 
let isPaused = false;
let filteredIndices = [];
let quizSettings = { passMark: 30, posMark: 1, negMark: 0.33 };
let currentQuizId = null;
let userUID = null; // To store logged-in user ID

// --- Helper: Shuffle ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. Get User UID from window (Set by exam.html gatekeeper)
    // We wait a bit to ensure Auth is ready, though exam.html handles it.
    const checkUserInterval = setInterval(() => {
        if (window.userUID) {
            userUID = window.userUID;
            clearInterval(checkUserInterval);
            initExam();
        }
    }, 500);
});

function initExam() {
    const urlParams = new URLSearchParams(window.location.search);
    currentQuizId = urlParams.get('id');
    
    if (currentQuizId) {
        document.getElementById('instContent').innerHTML = "<div style='text-align:center; padding:20px; color:#666;'>Loading Quiz Details... Please wait.</div>";
        loadQuizFromFirebase(currentQuizId);
    } else {
        alert("URL Error: No Quiz ID found.");
    }
    
    // Swipe Listeners
    setupSwipe('examSwipeArea', () => { if(!isPaused && currentIdx > 0) loadQuestion(currentIdx - 1); }, 
                              () => { if(!isPaused && currentIdx < questions.length - 1) loadQuestion(currentIdx + 1); });

    setupSwipe('resSwipeArea', () => { 
        const nIdx = filteredIndices.indexOf(currentResRealIdx);
        if(nIdx > 0) loadResultQuestion(filteredIndices[nIdx - 1]);
    }, () => { 
        const nIdx = filteredIndices.indexOf(currentResRealIdx);
        if(nIdx < filteredIndices.length - 1) loadResultQuestion(filteredIndices[nIdx + 1]);
    });

    // Checkbox Listener
    document.getElementById('agreeCheck').addEventListener('change', function() {
        document.getElementById('startTestBtn').disabled = !this.checked;
        if(this.checked && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(err => console.log("Fullscreen blocked"));
        }
    });
}

// --- Load Quiz Data ---
function loadQuizFromFirebase(quizId) {
    database.ref('quizzes/' + quizId).once('value').then((snapshot) => {
        const data = snapshot.val();
        if (data && data.questions) {
            // Setup Settings
            if(data.title) document.getElementById('instTitle').innerText = data.title;
            if(data.duration) timeLeft = parseInt(data.duration) * 60;
            if(data.passMark) quizSettings.passMark = parseFloat(data.passMark);
            if(data.posMark) quizSettings.posMark = parseFloat(data.posMark);
            if(data.negMark) quizSettings.negMark = parseFloat(data.negMark);

            document.getElementById('dispPosMark').innerText = "+" + quizSettings.posMark;
            document.getElementById('dispNegMark').innerText = "-" + quizSettings.negMark;

            questions = data.questions;

            // Randomization Logic
            if(data.randomizeQuestions) shuffleArray(questions);
            if(data.randomizeOptions) {
                questions.forEach(q => {
                    let cIdx = q.correctIndex || 0;
                    const correctText = q.options[cIdx];
                    let combinedOpts = q.options.map((opt, i) => ({ text: opt, img: (q.optImgs && q.optImgs[i]) ? q.optImgs[i] : null }));
                    shuffleArray(combinedOpts);
                    q.options = combinedOpts.map(o => o.text);
                    q.optImgs = combinedOpts.map(o => o.img);
                    q.correctIndex = q.options.indexOf(correctText);
                });
            }

            // Init Arrays
            status = new Array(questions.length).fill(0); 
            userAnswers = new Array(questions.length).fill(null);

            // --- SMART RESUME CHECK ---
            // ইউজারের আগের কোনো প্রোগ্রেস আছে কি না চেক করা হচ্ছে
            database.ref(`users/${userUID}/progress/${quizId}`).once('value', (progSnap) => {
                const prog = progSnap.val();
                let resumeBtnText = "I am ready to begin";
                let resumeMsg = "";

                if(prog && prog.status === 'ongoing') {
                    resumeMsg = `<div style="background:#fff3cd; color:#856404; padding:10px; border-radius:5px; margin-bottom:15px; border:1px solid #ffeeba;">
                        <strong>⚠️ অসমাপ্ত পরীক্ষা পাওয়া গেছে!</strong><br>
                        আপনি ${Math.floor(prog.timeLeft/60)} মিনিট বাকি রেখে বেরিয়েছিলেন। সেখান থেকেই শুরু করতে চান?
                    </div>`;
                    resumeBtnText = "Resume Test";
                    
                    // Restore Data logic needs to happen on Start Click
                    window.savedProgress = prog; // Store temporarily
                }

                // Render Instructions
                const instHTML = `
                    ${resumeMsg}
                    <div style="font-family: 'Roboto', sans-serif; font-size: 15px; line-height: 1.6; color:#333;">
                        <h3 style="margin-top:0; color:#0d47a1;">পরীক্ষার্থীর নাম:</h3>
                        <input type="text" id="stdName" placeholder="আপনার নাম লিখুন..." style="width:100%; padding:10px; margin-bottom:20px; border:1px solid #ccc; border-radius:4px;">
                        
                        <h3 style="margin-bottom:10px; color:#0d47a1;">নির্দেশাবলী:</h3>
                        <p>১. মোট সময়: ${data.duration} মিনিট | পাস মার্ক: ${quizSettings.passMark}</p>
                        <p>২. মার্কিং: সঠিক (+${quizSettings.posMark}), ভুল (-${quizSettings.negMark})</p>
                        <p>৩. পরীক্ষা মাঝপথে বন্ধ করলে, পরে <b>Resume</b> করা যাবে।</p>
                    </div>`;
                
                document.getElementById('instContent').innerHTML = instHTML;
                const startBtn = document.getElementById('startTestBtn');
                startBtn.innerText = resumeBtnText;
                
                // Auto-fill name if available
                if(localStorage.getItem('student_name')) {
                    document.getElementById('stdName').value = localStorage.getItem('student_name');
                }
            });

        } else {
            document.getElementById('instContent').innerHTML = "Quiz not found.";
        }
    });
}

// --- Start / Resume Test ---
document.getElementById('startTestBtn').addEventListener('click', () => {
    const name = document.getElementById('stdName').value.trim();
    if(!name) { alert("দয়া করে আপনার নাম লিখুন।"); return; }
    localStorage.setItem('student_name', name);

    // RESTORE PROGRESS IF AVAILABLE
    if(window.savedProgress) {
        userAnswers = window.savedProgress.userAnswers || userAnswers;
        status = window.savedProgress.qStatus || status;
        timeLeft = window.savedProgress.timeLeft || timeLeft;
        currentIdx = window.savedProgress.currentIdx || 0;
    }

    document.getElementById('instructionScreen').style.display = 'none';
    document.getElementById('quizMainArea').style.display = 'flex'; 
    if(document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    
    loadQuestion(currentIdx);
    startTimer();
    saveProgressToFirebase(); // Initial save
});

// --- SAVE PROGRESS (The Smart Feature) ---
function saveProgressToFirebase() {
    if(!userUID || !currentQuizId || isSubmitted) return;
    
    database.ref(`users/${userUID}/progress/${currentQuizId}`).set({
        status: 'ongoing',
        currentIdx: currentIdx,
        userAnswers: userAnswers,
        qStatus: status, // Save visited/marked status
        timeLeft: timeLeft,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        quizId: currentQuizId
    });
}

// --- Navigation & Actions ---
function loadQuestion(index) {
    if(status[index] === 0) status[index] = 1; 
    currentIdx = index;
    document.getElementById('currentQNum').innerText = index + 1;
    const q = questions[index];
    
    let qHTML = "";
    if(q.passage) qHTML += `<div class="passage-box"><strong>Passage:</strong><br>${q.passage.replace(/\n/g, '<br>')}</div>`;
    if(q.qImg) qHTML += `<img src="${q.qImg}" class="q-img-display">`;
    qHTML += q.question;
    
    document.getElementById('questionTextBox').innerHTML = qHTML;

    const container = document.getElementById('optionsContainer');
    container.innerHTML = '';
    
    const nextBtn = document.getElementById('saveNextBtn');
    if (index === questions.length - 1) { nextBtn.innerText = "Final Submit"; nextBtn.style.backgroundColor = "#ff5722"; } 
    else { nextBtn.innerText = "Save & Next"; nextBtn.style.backgroundColor = "#00c696"; }

    q.options.forEach((opt, i) => {
        const row = document.createElement('div');
        row.className = 'option-row';
        if(userAnswers[index] === i) row.classList.add('selected');
        
        let optContent = `<div class="radio-circle"></div><div style="flex:1;">`;
        if(q.optImgs && q.optImgs[i]) optContent += `<img src="${q.optImgs[i]}" style="max-width:100px; display:block; margin-bottom:5px;">`;
        optContent += `<div class="opt-text">${opt}</div></div>`;
        
        row.innerHTML = optContent;
        row.onclick = () => { if(isPaused) return; document.querySelectorAll('.option-row').forEach(r => r.classList.remove('selected')); row.classList.add('selected'); };
        container.appendChild(row);
    });

    if(window.MathJax) MathJax.typesetPromise();
    
    // Auto save on navigation
    saveProgressToFirebase();
}

function getSelIdx() { const s = document.querySelector('.option-row.selected'); return s ? Array.from(s.parentNode.children).indexOf(s) : null; }

document.getElementById('markReviewBtn').addEventListener('click', () => { 
    if(isPaused) return; 
    const i = getSelIdx(); 
    if(i!==null){ userAnswers[currentIdx]=i; status[currentIdx]=4; } else status[currentIdx]=3; 
    saveProgressToFirebase(); // Save
    if(currentIdx < questions.length - 1) loadQuestion(currentIdx + 1); else openDrawer();
});

document.getElementById('saveNextBtn').addEventListener('click', () => { 
    if(isPaused) return; 
    const i = getSelIdx(); 
    if(i!==null){ userAnswers[currentIdx]=i; status[currentIdx]=2; } else status[currentIdx]=1; 
    saveProgressToFirebase(); // Save
    
    if (currentIdx === questions.length - 1) { 
        if (confirm("আপনি কি নিশ্চিত যে আপনি পরীক্ষা শেষ করতে চান?")) submitTest(); 
    } else { 
        loadQuestion(currentIdx + 1); 
    }
});

document.getElementById('clearResponseBtn').addEventListener('click', () => { 
    if(isPaused) return; 
    document.querySelectorAll('.option-row').forEach(r => r.classList.remove('selected')); 
    userAnswers[currentIdx]=null; 
    status[currentIdx]=1; 
    saveProgressToFirebase(); // Save
});

// --- Timer & Pause ---
function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if(timeLeft <= 0) { clearInterval(timerInterval); submitTest(); return; }
        timeLeft--;
        let m = parseInt(timeLeft / 60), s = parseInt(timeLeft % 60);
        document.getElementById('timerDisplay').innerText = `${m}:${s<10?'0'+s:s}`;
        
        // Save progress every 10 seconds to reduce DB writes
        if(timeLeft % 10 === 0) saveProgressToFirebase();
    }, 1000);
}

document.getElementById('pauseBtn').addEventListener('click', () => {
    const b = document.getElementById('pauseBtn');
    if(!isPaused) { 
        clearInterval(timerInterval); isPaused=true; b.innerText="Resume"; b.style.background="#ff9800"; 
        document.querySelector('.content-area').style.opacity='0'; 
        saveProgressToFirebase(); // Save state on pause
    } else { 
        startTimer(); isPaused=false; b.innerText="Pause"; b.style.background="white"; 
        document.querySelector('.content-area').style.opacity='1'; 
    }
});

// --- SUBMIT TEST (Dual Save) ---
function submitTest() {
    if(isSubmitted) return;
    isSubmitted = true;
    clearInterval(timerInterval);
    
    let s=0, c=0, w=0, sk=0;
    questions.forEach((q, i) => { 
        const correctIdx = Number(q.correctIndex);
        const userAns = userAnswers[i];
        if(userAns !== null) { 
            if(userAns == correctIdx) { s += quizSettings.posMark; c++; } 
            else { s -= quizSettings.negMark; w++; } 
        } else { sk++; }
    });
    
    const score = s.toFixed(2);
    const stdName = document.getElementById('stdName').value || 'User';
    const finalData = {
        name: stdName, score: score, correct: c, wrong: w, 
        skipped: sk, date: new Date().toLocaleString(),
        totalQ: questions.length,
        userAnswers: userAnswers, // Saving answers for Analysis
        timestamp: firebase.database.ServerValue.TIMESTAMP
    };

    // SAVE LOCATION 1: User's Private History (For App Logic)
    database.ref(`users/${userUID}/results/${currentQuizId}`).push(finalData);
    
    // SAVE LOCATION 2: Admin's Common List (For Admin Panel)
    // Note: We are saving minimal data here for admin view
    database.ref(`results/${currentQuizId}`).push({
        name: stdName, score: score, correct: c, wrong: w, date: finalData.date
    });

    // MARK PROGRESS AS COMPLETED
    database.ref(`users/${userUID}/progress/${currentQuizId}`).update({
        status: 'completed',
        score: score,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    });

    // Show Result UI
    showResultUI(s, c, w, sk, score);
}

function showResultUI(s, c, w, sk, score) {
    document.getElementById('resScore').innerText = score; 
    document.getElementById('resCorrect').innerText = c; 
    document.getElementById('resWrong').innerText = w; 
    document.getElementById('resSkip').innerText = sk;
    
    const passBox = document.getElementById('passFailBox');
    if(s >= quizSettings.passMark) {
        passBox.innerHTML = `🎉 অভিনন্দন! আপনি পাস করেছেন।`; 
        passBox.style.background = "#d4edda"; passBox.style.color = "#155724"; 
    } else {
        const needed = (quizSettings.passMark - s).toFixed(2);
        passBox.innerHTML = `😞 দুঃখিত! আপনি ফেল করেছেন।<br><small>আরও ${needed} নম্বর প্রয়োজন ছিল।</small>`; 
        passBox.style.background = "#f8d7da"; passBox.style.color = "#721c24"; 
    }

    document.getElementById('resultModal').style.display = 'flex';
    switchTab('score');
    applyFilter('all');
}

// --- Result Analysis & Palette ---
// (বাকি অংশ আগের মতোই, শুধু UI রেন্ডারিং এর জন্য)
let currentResRealIdx = -1; 
function applyFilter(t) {
    document.querySelectorAll('.f-btn').forEach(b => { 
        b.classList.remove('active'); 
        if(b.innerText.toLowerCase() === t) b.classList.add('active'); 
    });
    filteredIndices = [];
    questions.forEach((q, i) => {
        const u = userAnswers[i];
        const correctIdx = Number(q.correctIndex);
        let st = u !== null ? (u == correctIdx ? 'correct' : 'wrong') : 'skipped';
        if(t === 'all' || t === st) filteredIndices.push(i);
    });
    renderResultPalette();
    if(filteredIndices.length > 0) { 
        document.getElementById('tab-solution-view').querySelector('.content-area').style.display = 'block';
        loadResultQuestion(filteredIndices[0]); 
    } else {
        document.getElementById('tab-solution-view').querySelector('.content-area').style.display = 'none';
    }
}

function renderResultPalette() {
    const c = document.getElementById('resPaletteContainer'); c.innerHTML = '';
    filteredIndices.forEach(idx => {
        const btn = document.createElement('div'); btn.className = 'rp-btn'; btn.innerText = idx + 1;
        const u = userAnswers[idx];
        const correctIdx = Number(questions[idx].correctIndex);
        if(u === null) btn.classList.add('skipped'); 
        else if(u == correctIdx) btn.classList.add('correct'); 
        else btn.classList.add('wrong');
        btn.onclick = () => { loadResultQuestion(idx); switchTab('solution'); };
        c.appendChild(btn);
    });
}

function loadResultQuestion(realIdx) {
    const nIdx = filteredIndices.indexOf(realIdx);
    if(nIdx === -1) return;
    currentResRealIdx = realIdx; 
    document.querySelectorAll('.rp-btn').forEach(b => b.classList.remove('active'));
    if(document.querySelectorAll('.rp-btn')[nIdx]) document.querySelectorAll('.rp-btn')[nIdx].classList.add('active');
    
    document.getElementById('resCurrentQNum').innerText = realIdx + 1;
    const u = userAnswers[realIdx];
    const q = questions[realIdx];
    const c = Number(q.correctIndex); 
    const b = document.getElementById('resQStatusBadge');

    if(u === null) { b.innerText = "Skipped"; b.style.background = "#ffc107"; } 
    else if(u == c) { b.innerText = "Correct"; b.style.background = "#26a745"; } 
    else { b.innerText = "Wrong"; b.style.background = "#dc3545"; }
    
    let qHTML = "";
    if(q.qImg) qHTML += `<img src="${q.qImg}" style="max-height:200px; max-width:100%; display:block; margin:0 auto 10px;">`;
    qHTML += q.question;
    document.getElementById('resQuestionText').innerHTML = qHTML;

    const con = document.getElementById('resOptionsContainer'); con.innerHTML = '';
    q.options.forEach((o, i) => {
        let cls = 'res-opt-row';
        if(i == c) cls += ' correct-ans';
        if(u == i && u != c) cls += ' user-wrong';
        let optContent = q.optImgs && q.optImgs[i] ? `<img src="${q.optImgs[i]}" style="height:50px; display:block;">` : '';
        con.innerHTML += `<div class="${cls}"><div class="res-circle"></div><div style="flex:1;">${optContent}<span>${o}</span></div></div>`;
    });
    
    const explBox = document.getElementById('resExplanation');
    if(q.explanation && q.explanation.trim() !== "") { 
        explBox.style.display = "block"; 
        let expContent = q.expImg ? `<img src="${q.expImg}" style="max-height:150px; display:block; margin-bottom:10px;">` : '';
        document.getElementById('resExplText').innerHTML = expContent + q.explanation; 
    } else { explBox.style.display = "none"; }
    
    if(window.MathJax) MathJax.typesetPromise();
    document.getElementById('resPrevBtn').onclick = () => { if(nIdx > 0) loadResultQuestion(filteredIndices[nIdx - 1]); };
    document.getElementById('resNextBtn').onclick = () => { if(nIdx < filteredIndices.length - 1) loadResultQuestion(filteredIndices[nIdx + 1]); };
}

function switchTab(tabName) {
    document.getElementById('btn-score').classList.remove('active');
    document.getElementById('btn-solution').classList.remove('active');
    document.getElementById('btn-' + tabName).classList.add('active');
    if(tabName === 'score') {
        document.getElementById('tab-score-view').style.display = 'block';
        document.getElementById('tab-solution-view').style.display = 'none';
    } else {
        document.getElementById('tab-score-view').style.display = 'none';
        document.getElementById('tab-solution-view').style.display = 'flex'; 
        document.getElementById('tab-solution-view').style.flexDirection = 'column';
    }
}

// Drawer & Other UI
function setupSwipe(elementId, onSwipeRight, onSwipeLeft) {
    const el = document.getElementById(elementId);
    let touchStartX = 0, touchEndX = 0;
    if(!el) return;
    el.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, {passive: true});
    el.addEventListener('touchend', e => { touchEndX = e.changedTouches[0].screenX; handleSwipe(); }, {passive: true});
    function handleSwipe() {
        if (touchEndX < touchStartX - 50) onSwipeLeft(); 
        if (touchEndX > touchStartX + 50) onSwipeRight(); 
    }
}
const drawer = document.getElementById('paletteSheet');
document.querySelector('.menu-icon').addEventListener('click', () => { renderPalette(); drawer.classList.add('open'); document.getElementById('sheetOverlay').style.display='block'; });
function closeDrawer() { drawer.classList.remove('open'); setTimeout(()=>document.getElementById('sheetOverlay').style.display='none', 300); }
document.getElementById('closeSheetBtn').addEventListener('click', closeDrawer);
document.getElementById('sheetOverlay').addEventListener('click', closeDrawer);

function renderPalette() {
    const grid = document.getElementById('paletteGrid'); grid.innerHTML = '';
    status.forEach((s, i) => {
        const btn = document.createElement('div'); btn.className = 'p-btn'; btn.innerText = i + 1;
        if(s===2) btn.classList.add('answered'); else if(s===1) btn.classList.add('not-answered');
        else if(s===3) btn.classList.add('marked'); else if(s===4) btn.classList.add('marked-ans');
        if(i===currentIdx) btn.classList.add('current');
        btn.onclick = () => { if(!isPaused) { loadQuestion(i); closeDrawer(); }};
        grid.appendChild(btn);
    });
}

// Fullscreen Logic
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && !isSubmitted) document.getElementById('fullscreenOverlay').style.display = 'flex';
    else document.getElementById('fullscreenOverlay').style.display = 'none';
});
document.getElementById('returnFsBtn').addEventListener('click', () => { if(document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); });
window.addEventListener('beforeunload', (e) => { if(!isSubmitted) { e.preventDefault(); e.returnValue = ''; } });