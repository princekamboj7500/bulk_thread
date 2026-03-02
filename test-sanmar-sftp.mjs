import SftpClient from "ssh2-sftp-client";
import dotenv from "dotenv";

dotenv.config();

const sftp = new SftpClient();

async function test() {
  try {
    console.log("Connecting to SanMar SFTP...");

    await sftp.connect({
      host: process.env.FTP_DOMAIN_SANMAR,
      username: process.env.FTP_USERNAME_SANMAR,
      password: process.env.FTP_PASSWORD_SANMAR,
      port: 2200,
      readyTimeout: 60000,
    });

    console.log(" Connected successfully!");

    const list = await sftp.list("/SanMarPDD");
    console.log("Files in /SanMarPDD:");
    console.log(list.map(f => f.name));

    await sftp.end();
    console.log("Connection closed.");
  } catch (err) {
    console.error("Connection failed:");
    console.error(err);
  }
}

test();
