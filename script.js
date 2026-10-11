// ตัวแปรส่วนกลาง
let currentUser = null;
let isCheckedIn = false; // ตัวแปรเช็คว่าเข้างานหรือยัง
let currentCameraMode = ""; 
let videoStream = null;
let currentLat = null, currentLng = null;

// เก็บรูป Checklist
let checklistPhotos = { demo: null, spec: null, clean: null };

// ฐานข้อมูลสินค้า
const products = [
    { id: 1, brand: "Apple", model: "iPhone 15 Pro", aliases: ["ip15p", "15p", "ip"], comm: 600 },
    { id: 2, brand: "Samsung", model: "Galaxy S24 Ultra", aliases: ["s24", "s24u", "ss"], comm: 1000 },
    { id: 3, brand: "Oppo", model: "Reno 11 5G", aliases: ["rn11", "reno", "oppo"], comm: 400 }
];
let currentSelectedProduct = null;

// --- นำทาง (Navigation) ---
function login() {
    const email = document.getElementById('email').value;
    if(!email) return alert("กรุณากรอกอีเมล");
    currentUser = { email: email };
    
    // โหลดสถานะการเข้างานจากเครื่อง (Mock)
    const savedStatus = localStorage.getItem('mockCheckInStatus');
    if(savedStatus === 'true') {
        isCheckedIn = true;
        document.getElementById('currentStatus').innerText = "เข้างานแล้ว ✅";
        document.getElementById('currentStatus').style.color = "green";
    }

    document.getElementById('loginSection').classList.add('hidden');
    document.getElementById('welcomeMsg').innerText = `สวัสดี, ${email}`;
    showMenu();
}

function showMenu() {
    hideAll();
    document.getElementById('mainMenu').classList.remove('hidden');
}

function navToCheckIn() {
    hideAll();
    document.getElementById('checkInSection').classList.remove('hidden');
}

function navToSales() {
    // ⚠️ ล็อคไว้ ถ้ายังไม่เช็คอิน จะเข้าหน้าขายไม่ได้
    if(!isCheckedIn) {
        alert("❌ กรุณาเช็คอินเข้างานให้เรียบร้อยก่อนเข้าสู่ระบบบันทึกการขายครับ");
        return;
    }
    hideAll();
    document.getElementById('salesSection').classList.remove('hidden');
    loadDashboard();
}

function hideAll() {
    document.getElementById('mainMenu').classList.add('hidden');
    document.getElementById('checkInSection').classList.add('hidden');
    document.getElementById('salesSection').classList.add('hidden');
}

function logout() { location.reload(); }

// --- ระบบกล้องส่วนกลาง ---
async function openCameraFor(mode) {
    currentCameraMode = mode;
    const modal = document.getElementById('cameraModal');
    const title = document.getElementById('cameraTitle');
    const sub = document.getElementById('cameraSubtitle');
    const scanBox = document.getElementById('scanBox');
    
    // ตั้งค่า UI กล้องตามโหมด
    if (mode === 'ocr') {
        title.innerText = "🔍 สแกน IMEI";
        sub.innerText = "กรอบเลข IMEI ให้อยู่ในเส้นสีเขียว";
        scanBox.classList.remove('hidden');
    } else {
        title.innerText = "📸 ถ่ายรูปยืนยัน";
        sub.innerText = "ระบบกำลังดึงพิกัด GPS...";
        scanBox.classList.add('hidden');
        await getGPS(); // ดึงพิกัดเฉพาะตอนตรวจสาขา
        sub.innerText = `พิกัด: ${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`;
    }

    modal.style.display = 'flex';
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        document.getElementById('videoElement').srcObject = videoStream;
    } catch (err) { alert("เปิดกล้องไม่ได้: " + err.message); closeCamera(); }
}

function closeCamera() {
    document.getElementById('cameraModal').style.display = 'none';
    if (videoStream) videoStream.getTracks().forEach(track => track.stop());
}

function getGPS() {
    return new Promise((resolve) => {
        if(navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
                currentLat = pos.coords.latitude; currentLng = pos.coords.longitude;
                resolve();
            }, () => { currentLat = 0; currentLng = 0; resolve(); });
        } else { resolve(); }
    });
}

async function takeSnapshot() {
    const video = document.getElementById('videoElement');
    const canvas = document.getElementById('canvasElement');
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (currentCameraMode === 'ocr') {
        // ประมวลผล OCR
        document.getElementById('cameraSubtitle').innerText = "กำลังประมวลผล OCR...";
        const dataUrl = canvas.toDataURL('image/jpeg');
        try {
            const result = await Tesseract.recognize(dataUrl, 'eng');
            const match = result.data.text.match(/\b\d{15}\b/);
            if (match) {
                document.getElementById('imeiInput').value = match[0];
                alert(`✅ สแกนสำเร็จ: ${match[0]}`);
                closeCamera();
            } else {
                alert("❌ หาเลข IMEI 15 หลักไม่พบ กรุณาถ่ายใหม่");
            }
        } catch (e) { alert("เกิดข้อผิดพลาดในการสแกน"); }
        
    } else {
        // ถ่ายรูป Checklist ธรรมดา
        const photoBase64 = canvas.toDataURL('image/jpeg', 0.5);
        if (['demo', 'spec', 'clean'].includes(currentCameraMode)) {
            checklistPhotos[currentCameraMode] = photoBase64;
            const imgEl = document.getElementById(`preview-${currentCameraMode}`);
            imgEl.src = photoBase64;
            imgEl.classList.remove('hidden');
        } else if (currentCameraMode === 'เข้างาน') {
            // เช็คอินสำเร็จ
            isCheckedIn = true;
            localStorage.setItem('mockCheckInStatus', 'true');
            document.getElementById('currentStatus').innerText = "เข้างานแล้ว ✅";
            document.getElementById('currentStatus').style.color = "green";
            alert("✅ บันทึกเข้างานและพิกัดสำเร็จ!");
            showMenu();
        } else if (currentCameraMode === 'ออกงาน') {
            isCheckedIn = false;
            localStorage.setItem('mockCheckInStatus', 'false');
            document.getElementById('currentStatus').innerText = "ออกงานแล้ว 🚪";
            document.getElementById('currentStatus').style.color = "#666";
            alert("✅ บันทึกออกงานสำเร็จ!");
            showMenu();
        }
        closeCamera();
    }
}

// --- ลอจิก Check-In ---
function startMainCheckIn(type) {
    if (type === 'เข้างาน') {
        if (!checklistPhotos.demo || !checklistPhotos.spec || !checklistPhotos.clean) {
            return alert("❌ กรุณาถ่ายรูปการตรวจสอบสาขาให้ครบ 3 ข้อ");
        }
        if (!document.querySelector('input[name="stockStatus"]:checked')) {
            return alert("❌ กรุณาเลือกสถานะสต๊อคสินค้า");
        }
    }
    openCameraFor(type);
}

// --- ลอจิก Sales ---
function searchProduct() {
    const input = document.getElementById('searchInput').value.toLowerCase().trim();
    const suggBox = document.getElementById('suggestions');
    suggBox.innerHTML = '';
    if (input.length === 0) { suggBox.style.display = 'none'; return; }

    const results = products.filter(p => `${p.brand} ${p.model}`.toLowerCase().includes(input) || p.aliases.some(a => a.includes(input)));
    
    if (results.length > 0) {
        results.forEach(p => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `<b>${p.brand}</b> ${p.model} <span style="float:right; color:#6CAE75;">+฿${p.comm}</span>`;
            div.onclick = () => selectProduct(p);
            suggBox.appendChild(div);
        });
        suggBox.style.display = 'block';
    } else { suggBox.style.display = 'none'; }
}

function selectProduct(product) {
    currentSelectedProduct = product;
    document.getElementById('searchInput').style.display = 'none';
    document.getElementById('suggestions').style.display = 'none';
    document.getElementById('dispBrandModel').innerText = `${product.brand} ${product.model}`;
    document.getElementById('dispComm').innerText = product.comm;
    document.getElementById('selectedProduct').style.display = 'flex';
}

function clearSelection() {
    currentSelectedProduct = null;
    document.getElementById('searchInput').value = '';
    document.getElementById('searchInput').style.display = 'block';
    document.getElementById('selectedProduct').style.display = 'none';
}

function saveSale() {
    const imei = document.getElementById('imeiInput').value.trim();
    if (!currentSelectedProduct) return alert("❌ กรุณาเลือกสินค้า");
    if (imei.length < 15) return alert("❌ กรุณากรอก IMEI ให้ครบ 15 หลัก");

    const record = { date: new Date().toISOString(), brand: currentSelectedProduct.brand, model: currentSelectedProduct.model, imei: imei, comm: currentSelectedProduct.comm };
    let sales = JSON.parse(localStorage.getItem('mockSales') || '[]');
    sales.push(record);
    localStorage.setItem('mockSales', JSON.stringify(sales));

    document.getElementById('saveStatus').innerHTML = `✅ บันทึกสำเร็จ! คุณได้รับค่าคอม <b>+${record.comm} บาท</b>`;
    document.getElementById('saveStatus').style.color = "green";
    clearSelection();
    document.getElementById('imeiInput').value = '';
    loadDashboard();
}

function loadDashboard() {
    const sales = JSON.parse(localStorage.getItem('mockSales') || '[]');
    const tbody = document.getElementById('salesTableBody');
    tbody.innerHTML = '';

    const todayStr = new Date().toLocaleDateString('th-TH');
    let countToday = 0, sumMonthComm = 0;

    sales.reverse().forEach(sale => {
        const saleDate = new Date(sale.date);
        if (saleDate.toLocaleDateString('th-TH') === todayStr) {
            countToday++;
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${saleDate.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'})}</td>
                            <td><b>${sale.brand}</b><br><small>${sale.model}</small></td>
                            <td style="font-size: 0.8em;">${sale.imei}</td>
                            <td class="comm-text">+฿${sale.comm}</td>`;
            tbody.appendChild(tr);
        }
        sumMonthComm += sale.comm; 
    });

    document.getElementById('todayCount').innerText = countToday;
    document.getElementById('monthComm').innerText = sumMonthComm.toLocaleString();
}
