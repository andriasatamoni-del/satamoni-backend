require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/branches", require("./routes/branches"));
app.use("/api/menu", require("./routes/menu"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/inventory", require("./routes/inventory"));
app.use("/api/expenses", require("./routes/expenses"));
app.use("/api/purchases", require("./routes/purchases"));
app.use("/api/kitchen-transfers", require("./routes/kitchen-transfers"));
app.use("/api/suppliers", require("./routes/suppliers"));
app.use("/api/cash-sessions", require("./routes/cash-sessions"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/hr", require("./routes/hr"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/config", require("./routes/config"));

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Satamoni backend running on port ${PORT}`));
