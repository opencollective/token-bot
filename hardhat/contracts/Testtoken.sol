// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract TestToken is ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _mint(msg.sender, 0);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }

    // Allow the minter to also burn tokens from any account
    // This is useful when an account has been lost and you want to mint new tokens to replace the lost ones
    // without impacting the totalSupply
    // Given that all community accounts can be recovered, this is only useful for old accounts.abi
    // Therefore, we should remove this function as soon as possible.
    function burnFrom(
        address account,
        uint256 amount
    ) public override onlyRole(MINTER_ROLE) {
        _burn(account, amount);
    }
}
