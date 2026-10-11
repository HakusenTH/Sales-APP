// --- 1. ฐานข้อมูลจำลอง (Mock Database) ---
const products = [
    { id: 1, brand: "Apple", model: "iPhone 15 Pro", aliases: ["ip15p", "15p", "ip"], comm: 600 },
    { id: 2, brand: "Apple", model: "iPhone 15 Pro Max", aliases: ["ip15pm", "15pm"], comm: 800 },
    { id: 3, brand: "Samsung", model: "Galaxy S24 Ultra", aliases: ["s24", "s24u", "ss"], comm: 1000 },
    { id: 4, brand: "Samsung", model: "Galaxy A55 5G", aliases: ["a55", "ss"], comm: 300 },
    { id: 5, brand: "Oppo", model: "Reno 11 5G", aliases: ["rn11", "reno", "oppo"], comm: 400 },
    { id: 6, brand: "Oppo", model: "A79 5G", aliases: ["a79"], comm: 200 },
    { id: 7, brand: "Vivo", model: "V30 5G", aliases: ["v30", "vivo"], comm: 400 },
    { id: 8, brand: "Xiaomi", model: "Redmi Note 13", aliases: ["rm13", "note13", "mi"], comm: 250 }
];

let currentSelectedProduct = null;
let videoStream = null;

// โหลดข้อมูลจาก LocalStorage ตอนเปิดหน้าเว็บ
window.onload = () => {
    loadDashboard();
};

// --- 2. ระบบค้นหาสินค้า (Autocomplete) ---
function searchProduct() {
    const input = document.getElementById('searchInput').value.toLowerCase().trim();
    const suggBox = document.getElementById('suggestions');
    suggBox.innerHTML = '';
    
    if (input.length === 0) {
        suggBox.style.display = 'none';
        return;
    }

    // ค้นหาจาก brand, model หรือ aliases
    const results = products.filter(p => {
        const textToSearch = `${p.brand} ${p.model}`.toLowerCase();
        const matchAlias = p.aliases.some(alias => alias.includes(input));
        return textToSearch.includes(input) || matchAlias;
    });

    if (results.length > 0) {
        results.forEach(p => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `<b>${p.brand}</b> ${p.model} <span style="float:right; color:#6CAE75;">+฿${p.comm}</span>`;
            div.onclick = () => selectProduct(p);
            suggBox.appendChild(div);
        });
        suggBox.style.display = 'block';
    } else {
        suggBox.style.display = 'none';
    }
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
    const searchInput = document.getElementById('searchInput');
    searchInput.value = '';
    searchInput.style.display = 'block';
    searchInput.focus();
    document.getElementById('selectedProduct').style.display = 'none';
}

// --- 3. ระบบ OCR ด้วย Tesseract.js ---
async function openCamera() {
    document.getElementById('cameraModal').style.display = 'flex';
    document.getElementById('ocrStatus').innerText = "พร้อมสแกน...";
    try {
        // เน้นใช้กล้องหลังแบบโฟกัสใกล้ (ถ้ามือถือรองรับ)
        videoStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment", advanced: [{ focusMode: "continuous" }] } 
        });
        document.getElementById('videoElement').srcObject = videoStream;
    } catch (err) {
        alert("ไม่สามารถเข้าถึงกล้องได้: " + err.message);
        closeCamera();
    }
}

function closeCamera() {
    document.getElementById('cameraModal').style.display = 'none';
    if (videoStream) videoStream.getTracks().forEach(track => track.stop());
}

async function captureAndOCR() {
    const video = document.getElementById('videoElement');
    const canvas = document.getElementById('canvasElement');
    const status = document.getElementById('ocrStatus');
    const ctx = canvas.getContext('2d');

    status.innerText = "กำลังประมวลผลรูปภาพ (OCR)... กรุณารอสักครู่";
    status.style.color = "yellow";

    // จับภาพจากวิดีโอ
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const imageDataUrl = canvas.toDataURL('image/jpeg');

    try {
        // เรียกใช้ Tesseract อ่านข้อความ (ใช้ภาษา eng เพราะ IMEI เป็นตัวเลข)
        const result = await Tesseract.recognize(imageDataUrl, 'eng');
        const text = result.data.text;
        
        // ใช้ Regex ค้นหาตัวเลข 15 หลักที่ติดกัน (รูปแบบมาตรฐาน IMEI)
        const imeiRegex = /\b\d{15}\b/;
        const match = text.match(imeiRegex);

        if (match) {
            // เจอ IMEI
            document.getElementById('imeiInput').value = match[0];
            status.innerText = `✅ สแกนสำเร็จ: ${match[0]}`;
            status.style.color = "#00ff00";
            setTimeout(closeCamera, 1500);
        } else {
            // ไม่เจอเลข 15 หลัก
            status.innerText = "❌ หาเลข IMEI (15 หลัก) ไม่พบ กรุณาถ่ายให้ชัดขึ้นหรือกรอกเอง";
            status.style.color = "red";
        }
    } catch (err) {
        status.innerText = "❌ เกิดข้อผิดพลาดในการอ่านข้อความ";
        status.style.color = "red";
        console.error(err);
    }
}

// --- 4. บันทึกและแดชบอร์ด ---
function saveSale() {
    const imei = document.getElementById('imeiInput').value.trim();
    const status = document.getElementById('saveStatus');

    if (!currentSelectedProduct) {
        status.innerText = "❌ กรุณาเลือกสินค้า"; status.style.color = "red"; return;
    }
    if (imei.length < 15) {
        status.innerText = "❌ กรุณากรอก IMEI ให้ครบ 15 หลัก"; status.style.color = "red"; return;
    }

    const record = {
        id: Date.now(),
        date: new Date().toISOString(),
        brand: currentSelectedProduct.brand,
        model: currentSelectedProduct.model,
        imei: imei,
        comm: currentSelectedProduct.comm
    };

    // ดึงข้อมูลเก่า และเพิ่มของใหม่
    let sales = JSON.parse(localStorage.getItem('mockSales') || '[]');
    sales.push(record);
    localStorage.setItem('mockSales', JSON.stringify(sales));

    // โชว์แจ้งเตือนคอมมิชชั่นรายตัว
    status.innerHTML = `✅ บันทึกสำเร็จ! คุณได้รับค่าคอมมิชชั่น <b>+${record.comm} บาท</b>`;
    status.style.color = "green";

    // รีเซ็ตฟอร์ม
    clearSelection();
    document.getElementById('imeiInput').value = '';
    
    // อัปเดตข้อมูล
    loadDashboard();
}

function loadDashboard() {
    const sales = JSON.parse(localStorage.getItem('mockSales') || '[]');
    const tbody = document.getElementById('salesTableBody');
    tbody.innerHTML = '';

    const today = new Date();
    const todayStr = today.toLocaleDateString('th-TH');
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();

    let countToday = 0;
    let sumMonthComm = 0;

    // วนลูปจากใหม่ไปเก่า
    sales.reverse().forEach(sale => {
        const saleDate = new Date(sale.date);
        const saleDateStr = saleDate.toLocaleDateString('th-TH');
        
        // คำนวณสรุปยอด
        if (saleDateStr === todayStr) countToday++;
        if (saleDate.getMonth() === currentMonth && saleDate.getFullYear() === currentYear) {
            sumMonthComm += sale.comm;
        }

        // แสดงแค่ของวันนี้ในตาราง
        if (saleDateStr === todayStr) {
            const timeStr = saleDate.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${timeStr}</td>
                <td><b>${sale.brand}</b> ${sale.model}</td>
                <td style="font-size: 0.85em;">${sale.imei}</td>
                <td class="comm-text">+฿${sale.comm}</td>
            `;
            tbody.appendChild(tr);
        }
    });

    if (countToday === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">ยังไม่มีรายการขายวันนี้</td></tr>`;
    }

    document.getElementById('todayCount').innerText = countToday;
    document.getElementById('monthComm').innerText = sumMonthComm.toLocaleString();
}