import axios from 'axios';
import puppeteer from 'puppeteer';
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import pkg from 'pg';

const { Client } = pkg;
dotenv.config();

const cloneVideos = async (url, filepath) => {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
        });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(filepath);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`Failed to download ${url}:`, error.message);
    }
};

(async () => {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--ignore-certificate-errors'],
    });
    const page = await browser.newPage();
    
    try {
        await page.goto('https://www.thomoe.in/', { waitUntil: 'networkidle2' });
    } catch (error) {
        console.error('Error navigating to the page:', error);
        await browser.close();
        return;
    }
    
    const links = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        const srcLinks = [];

        buttons.forEach(button => {
            const onclickAttr = button.getAttribute('onclick');
            if (onclickAttr) {
                const match = onclickAttr.match(/src='([^']+)'/);
                if (match && match[1]) {
                    srcLinks.push(match[1]);
                }
            }
        });
        return srcLinks;
    });
    console.log(links);

    const today = new Date();
    const folderName = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

    for(const link of links) {
        await page.goto(link, { waitUntil: 'networkidle2' });

        const folderPath = path.join(process.cwd(), 'public', 'media', 'videos', folderName);

        const client = new Client({
            connectionString: process.env.DATABASE_URI,
        });

        try {
            await client.connect();
            const videoSaveQuery = `
                INSERT INTO videos(title, video_url, is_public, original_link, category_id)
                VALUES($1, $2, $3, $4, $5)
                RETURNING id
            `;

            for (const src of links) {
                const checkExistQuery = 'SELECT id FROM videos WHERE original_link = $1';
                const res = await client.query(checkExistQuery, [src]);

                if (res.rows.length > 0) {
                    console.log(`Skipping download: ${src} already exists in the database.`);
                    continue;
                }

                const match = src.match(/cpc\d+/);

                if (match) {
                    const cpcFolder = match[0];
                    const specificFolderPath = path.join(process.cwd(), 'public', 'media', 'videos', cpcFolder);

                    if (!fs.existsSync(specificFolderPath)) {
                        fs.mkdirSync(specificFolderPath, { recursive: true });
                    }

                    const filesInForder = fs.readdirSync(specificFolderPath);
                    const nextIndex = filesInForder.length + 1;

                    const filename = `${cpcFolder}_${folderName}_${nextIndex}.mp4`;
                    const filePath = path.join(specificFolderPath, filename);
                    await cloneVideos(src, filePath);
                    console.log(`Downloaded and saved ${filePath}`);

                    const cate = cpcFolder;
                    const relativeFilePath = filePath.replace(path.join(process.cwd(), 'public'), '').replace(/\\/g, '/');

                    // Lấy ID của category tương ứng
                    const categoryIdQuery = 'SELECT id FROM categories WHERE title = $1';
                    const categoryRes = await client.query(categoryIdQuery, [cate]);

                    let categoryId;
                    if (categoryRes.rows.length > 0) {
                        categoryId = categoryRes.rows[0].id;
                    } else {
                        // Nếu category không tồn tại, tạo mới category và lấy ID
                        const insertCategoryQuery = 'INSERT INTO categories(title) VALUES($1) RETURNING id';
                        const newCategoryRes = await client.query(insertCategoryQuery, [cate]);
                        categoryId = newCategoryRes.rows[0].id;
                    }

                    if(fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                        await client.query(videoSaveQuery, [
                            `Video ${cpcFolder}_${nextIndex}`,
                            relativeFilePath,
                            false,
                            src,
                            categoryId,
                        ]);
                    } else {
                        console.log(`Failed to download: ${relativeFilePath} is invalid or empty`);
                    }
                }
            }
        } catch (error) {
            console.log('Error saving to database:', error);
        } finally {
            await client.end();
        }
    }

    await browser.close();
})();
