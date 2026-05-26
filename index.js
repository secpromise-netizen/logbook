const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

// ==========================================
// 1. CONFIGURATION
// ==========================================

const LOGBOOK_USER = "pelcd500901";
const LOGBOOK_PASS = "51427938";

const AUTH_URL = "https://kankrao.tpmap.in.th/auth";
const API_OLD = "https://api2.logbook.emenscr.in.th/people/find";
const API_NEW_MEMBER = "https://api2.logbook.emenscr.in.th/v1/tpmaplogbook68/housemember/member/";
const API_NEW_HOUSEMEMBER = "https://api2.logbook.emenscr.in.th/v1/tpmaplogbook68/housemember/housemember/";
const API_NEW_HOUSE = "https://api2.logbook.emenscr.in.th/v1/tpmaplogbook68/housesurvey/house/";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const jar = new CookieJar();
const clientHttp = wrapper(axios.create({ 
    jar, 
    withCredentials: true,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
    }
}));

// ==========================================
// 2. CORE ENGINE (DIRECT HTTP SEARCH)
// ==========================================

async function loginToLogbook() {
    console.log("[SYSTEM] Attempting Direct HTTP Login...");
    try {
        const params = new URLSearchParams();
        params.append('username', LOGBOOK_USER);
        params.append('password', LOGBOOK_PASS);

        await clientHttp.post(AUTH_URL, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log("[LOGBOOK] Login Success & Session Active.");
        return true;
    } catch (e) {
        console.error(`[LOGBOOK] Login Failed: ${e.message}`);
        return false;
    }
}

function extractVal(dataSources, possibleKeys) {
    for (const source of dataSources) {
        if (!source || typeof source !== 'object') continue;
        for (const pk of possibleKeys) {
            for (const [k, v] of Object.entries(source)) {
                if (String(k).toLowerCase() === pk.toLowerCase()) {
                    if (v !== null && v !== undefined && !['none', 'null', '-', '', 'nan'].includes(String(v).toLowerCase())) {
                        return String(v).trim();
                    }
                }
            }
        }
    }
    return "-";
}

async function runLogbookSearch(queryValue, type) {
    try {
        let results = { api_old: null, api_new: null, house_data: null, housesurvey_data: null };
        let foundAny = false;
        let nidForMember = (type === 'id') ? queryValue : null;

        if (type === 'houseid') {
            try {
                const reqHouse = await clientHttp.get(`${API_NEW_HOUSEMEMBER}${queryValue}`);
                if (reqHouse.data && Array.isArray(reqHouse.data) && reqHouse.data.length > 0) {
                    results.house_data = reqHouse.data;
                    foundAny = true;

                    let extractedNid = extractVal([reqHouse.data[0]], ["NID", "cid", "citizen_id", "id_card"]);
                    if (extractedNid !== "-") {
                        nidForMember = extractedNid;

                        const payload = new URLSearchParams();
                        payload.append('draw', '1');
                        payload.append('start', '0');
                        payload.append('length', '10');
                        payload.append('search[value]', nidForMember);

                        const reqOld = await clientHttp.post(API_OLD, payload, {
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                        });
                        if (reqOld.data && reqOld.data.data && reqOld.data.data.length > 0) {
                            results.api_old = reqOld.data.data[0];
                        }
                    }
                }
            } catch (err) {
                if (err.response && [401, 403].includes(err.response.status)) return "UNAUTHORIZED";
            }

            try {
                const reqSurvey = await clientHttp.get(`${API_NEW_HOUSE}${queryValue}`);
                if (reqSurvey.data && Array.isArray(reqSurvey.data) && reqSurvey.data.length > 0) {
                    results.housesurvey_data = reqSurvey.data[0];
                    foundAny = true;
                }
            } catch (e) {}

        } else {
            const payload = new URLSearchParams();
            payload.append('draw', '1');
            payload.append('start', '0');
            payload.append('length', '10');

            if (type === 'id') {
                payload.append('search[value]', queryValue);
                payload.append('NID', queryValue);
                payload.append('fullname', '');
                payload.append('lastname', '');
            } else if (type === 'name') {
                payload.append('search[value]', '');
                payload.append('NID', '');
                payload.append('fullname', queryValue);
                payload.append('lastname', '');
            }

            let resOld;
            try {
                const reqOld = await clientHttp.post(API_OLD, payload, {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });
                resOld = reqOld.data;
            } catch (err) {
                if (err.response && [401, 403].includes(err.response.status)) return "UNAUTHORIZED";
            }

            if (resOld && resOld.data && resOld.data.length > 0) {
                if (type === 'name' && resOld.data.length > 1) {
                    return { MULTIPLE_MATCHES: resOld.data, query: queryValue };
                }
                results.api_old = resOld.data[0];
                foundAny = true;
            }

            if (results.api_old) {
                let extractedNid = extractVal([results.api_old], ["NID", "cid", "citizen_id", "id_card"]);
                if (extractedNid !== "-") nidForMember = extractedNid;
            }
        }

        if (nidForMember) {
            try {
                const reqNew = await clientHttp.get(`${API_NEW_MEMBER}${nidForMember}`);
                if (reqNew.data && Array.isArray(reqNew.data) && reqNew.data.length > 0) {
                    let actualData = reqNew.data[0];
                    if (actualData && !actualData.message) {
                        results.api_new = actualData;
                        foundAny = true;

                        if (type !== 'houseid') {
                            let houseId = extractVal([actualData], ["house_id", "houseId", "id_house", "_id"]);
                            if (actualData.house_id) houseId = actualData.house_id;

                            if (houseId !== "-" && String(houseId).length > 10) {
                                const reqHouse = await clientHttp.get(`${API_NEW_HOUSEMEMBER}${houseId}`);
                                if (reqHouse.data && Array.isArray(reqHouse.data) && reqHouse.data.length > 0) {
                                    results.house_data = reqHouse.data;
                                }

                                const reqSurvey = await clientHttp.get(`${API_NEW_HOUSE}${houseId}`);
                                if (reqSurvey.data && Array.isArray(reqSurvey.data) && reqSurvey.data.length > 0) {
                                    results.housesurvey_data = reqSurvey.data[0];
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                if (err.response && [401, 403].includes(err.response.status)) return "UNAUTHORIZED";
            }
        }

        if (!foundAny) return null;
        return results;
    } catch (e) {
        return "ERROR";
    }
}

// ==========================================
// 3. DATA FORMATTER HELPER (THAI STRING VALUE)
// ==========================================

// ฟังก์ชันดึงค่าสลับมาต่อกันเป็นข้อความภาษาไทยตรงๆ อ่านและนำไปแมปใช้ง่ายตามต้องการ
function buildAddress(d) {
    let addrParts = [];
    let an = d.address_num; let mo = d.moo;
    let vl = d.village_name; let tm = d.tambol_name || d.tumbol_name;
    let am = d.amphur_name || d.ampuhur_name; let pv = d.province_name;
    
    if (an && !['','null','None','-'].includes(String(an))) addrParts.push(`เลขที่ ${an}`);
    if (mo && !['','null','None','-'].includes(String(mo))) addrParts.push(`ม.${mo}`);
    if (vl && !['','null','None','-'].includes(String(vl))) addrParts.push(`บ.${vl}`);
    if (tm && !['','null','None','-'].includes(String(tm))) addrParts.push(`ต.${tm}`);
    if (am && !['','null','None','-'].includes(String(am))) addrParts.push(`อ.${am}`);
    if (pv && !['','null','None','-'].includes(String(pv))) addrParts.push(`จ.${pv}`);
    
    return addrParts.length > 0 ? addrParts.join(" ") : "-";
}

function formatJsonOutput(rawData) {
    if (!rawData) return null;
    
    const keyMapping = {
        "NID": "nationalId", "gender": "gender", "birthdate": "birthdate",
        "ebmn_age": "ageYears", "ebmn_age_month": "ageMonths",
        "occupation": "occupation", "education": "education", "religion": "religion",
        "relation": "householdStatus", "chronic_patient": "chronicPatient",
        "self_reliance": "selfReliance", "main_right": "medicalRight",
        "main_hospital": "mainHospital", "disabled": "isDisabled", "house_id": "houseId",
        "HOUSE_MEMBER_CNT": "householdMemberCount", "house_type": "houseType", 
        "land_occupation_type": "landOccupationType", "HH_income": "householdIncomePerYear",
        "avg_individual_income": "averageIncomePerPersonPerYear", "formal_debt": "formalDebt", 
        "informal_debt": "informalDebt", "yearly_savings": "yearlySavings", "cid": "nationalId", "citizen_id": "nationalId"
    };

    const junkPrefixes = ["DT", "indicator", "F1", "EEF", "V_", "MOF", "MPI", "poor", "sum_", "_id", "ID", "dla"];
    const extraSkip = ["house_data_ID", "village_ID", "tambol_ID", "amphur_ID", "province_ID", "village_ID_62", "house_data_ID_62", "dependent_cnt", "dependent_apx_bedbound_cnt", "dependent_disabled_cnt", "dependent_elderly_cnt", "dependent_child_cnt", "have_address_num", "disabled_registered", "elderly_registered", "sum_important_ind", "prefix_name", "name", "surname", "address_num", "moo", "village_name", "tambol_name", "tumbol_name", "amphur_name", "ampuhur_name", "province_name", "age", "age_year"];

    const cleanSingle = (d) => {
        let res = {};
        let fullName = `${d.prefix_name || ''}${d.name || ''} ${d.surname || ''}`.trim();
        if (fullName) res["fullName"] = fullName;

        let finalAge = d.age || d.ebmn_age || d.age_year || "-";
        if (finalAge !== "-") res["ageYears"] = parseInt(finalAge) || finalAge;

        for (let [k, v] of Object.entries(d)) {
            if (extraSkip.includes(k)) continue;
            if (v === null || v === undefined || ["null", "", "-", "nan"].includes(String(v).toLowerCase())) continue;
            if (junkPrefixes.some(p => k.startsWith(p)) && !["NID", "house_id", "HOUSE_MEMBER_CNT"].includes(k)) continue;

            let keyName = keyMapping[k] || k;
            
            if (!isNaN(v) && k !== "NID" && k !== "house_id" && k !== "cid" && k !== "citizen_id") {
                res[keyName] = Number(v);
            } else {
                res[keyName] = v;
            }
        }

        // ยัดที่อยู่กลับมาในรูปแบบตัวแปร String ข้อความไทยตามแบบฉบับเดิม
        let addressStr = buildAddress(d);
        if (addressStr !== "-") res["address"] = addressStr;
        
        return res;
    };

    if (Array.isArray(rawData)) {
        return rawData.map(item => cleanSingle(item));
    }
    return cleanSingle(rawData);
}

async function handleSearchRequest(req, res, queryValue, type) {
    let data = await runLogbookSearch(queryValue, type);

    if (data === "UNAUTHORIZED") {
        console.log("[WARNING] Session Expired. Re-logging in...");
        const loginSuccess = await loginToLogbook();
        if (loginSuccess) {
            data = await runLogbookSearch(queryValue, type);
        } else {
            return res.status(500).json({ status: "error", message: "Failed to refresh system session token" });
        }
    }

    if (data === "ERROR") return res.status(500).json({ status: "error", message: "External internal database connection error" });
    if (!data) return res.status(404).json({ status: "not_found", message: `Data not found for query: ${queryValue}` });

    if (data.MULTIPLE_MATCHES) {
        let options = data.MULTIPLE_MATCHES.slice(0, 10).map((m) => ({
            choice_id: m.NID || m.cid || m.citizen_id,
            name: `${m.prefix_name || ''}${m.name || ''} ${m.surname || ''}`.trim(),
            age: parseInt(m.age || m.ebmn_age) || "-",
            address: buildAddress(m)
        }));

        return res.json({
            status: "multiple_matches",
            message: "Multiple records found. Please use the 'choice_id' to search again via the ID route for accurate data.",
            matches_count: options.length,
            options: options
        });
    }

    return res.json({
        status: "success",
        search_type: type,
        results: {
            api_old: formatJsonOutput(data.api_old),
            api_new_member: formatJsonOutput(data.api_new),
            api_new_housemember: formatJsonOutput(data.house_data),
            api_new_housesurvey: formatJsonOutput(data.housesurvey_data)
        }
    });
}

// ==========================================
// 4. EXPRESS ROUTING
// ==========================================

app.get('/', (req, res) => {
    res.json({
        status: "online",
        message: "TPMAP Clean API System is ready",
        endpoints: {
            search_by_id: "/api/search/id/:id",
            search_by_name: "/api/search/name/:name",
            search_by_houseid: "/api/search/houseid/:houseid"
        }
    });
});

app.get('/api/search/id/:id', async (req, res) => {
    const idCard = req.params.id.replace(/\s+/g, "");
    if (!/^\d{13}$/.test(idCard)) {
        return res.status(400).json({ status: "bad_request", message: "Invalid National ID format. Must be exactly 13 numeric digits." });
    }
    await handleSearchRequest(req, res, idCard, 'id');
});

app.get('/api/search/name/:name', async (req, res) => {
    const fullName = req.params.name.trim();
    if (fullName.length < 2) {
        return res.status(400).json({ status: "bad_request", message: "Invalid name parameter. Character length must be at least 2." });
    }
    await handleSearchRequest(req, res, fullName, 'name');
});

app.get('/api/search/houseid/:houseid', async (req, res) => {
    const houseId = req.params.houseid.replace(/\s+/g, "");
    if (houseId.length !== 32) {
        return res.status(400).json({ status: "bad_request", message: "Invalid House ID format. Must be exactly 32 hexadecimal characters." });
    }
    await handleSearchRequest(req, res, houseId, 'houseid');
});

app.listen(PORT, async () => {
    console.log(`🌐 Express API Server running on port ${PORT}`);
    await loginToLogbook();
});